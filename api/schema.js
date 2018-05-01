import NodeGeocoder from 'node-geocoder';
import request from 'request';

import { merge } from 'lodash';
import { makeExecutableSchema } from 'graphql-tools';
import { withFilter } from 'graphql-subscriptions';

import { schema as gitHubSchema, resolvers as gitHubResolvers } from './github/schema';
import { schema as sqlSchema, resolvers as sqlResolvers } from './sql/schema';
import { pubsub } from './subscriptions';

const rootSchema = [`

# A list of options for the sort order of the feed
enum FeedType {
  # Sort by a combination of freshness and score, using Reddit's algorithm
  HOT

  # Newest entries first
  NEW

  # Highest score entries first
  TOP
}

type Query {
  # A feed of repository submissions
  feed(
    # The sort order for the feed
    type: FeedType!,

    # The number of items to skip, for pagination
    offset: Int,

    # The number of items to fetch starting from the offset, for pagination
    limit: Int
  ): [Entry]

  # A single entry
  entry(
    # The full repository name from GitHub, e.g. "apollostack/GitHunt-API"
    repoFullName: String!
  ): Entry

  # Return the currently logged in user, or null if nobody is logged in
  currentUser: User @cacheControl(scope: PRIVATE)
}

# The type of vote to record, when submitting a vote
enum VoteType {
  UP
  DOWN
  CANCEL
}

type Mutation {
  # Submit a new repository, returns the new submission
  submitRepository(
    # The full repository name from GitHub, e.g. "apollostack/GitHunt-API"
    repoFullName: String!
  ): Entry

  # Vote on a repository submission, returns the submission that was voted on
  vote(
    # The full repository name from GitHub, e.g. "apollostack/GitHunt-API"
    repoFullName: String!,

    # The type of vote - UP, DOWN, or CANCEL
    type: VoteType!
  ): Entry

  # Comment on a repository, returns the new comment
  submitComment(
    # The full repository name from GitHub, e.g. "apollostack/GitHunt-API"
    repoFullName: String!,

    # The text content for the new comment
    commentContent: String!
  ): Comment
}

type Subscription {
  # Subscription fires on every comment added
  commentAdded(repoFullName: String!): Comment
}

type Location {
  city: String
  country: String
  coords: [Float]
  mapLink: String
  weather: Weather
}

type Weather {
  summary: String
  temperature: Float
  coords: [Float]
}

schema {
  query: Query
  mutation: Mutation
  subscription: Subscription
}

`];

// Set the baseUrl and urlParams for Dark Sky API call
const baseUrl = 'https://api.darksky.net/forecast/';
const urlParams = '?units=us&exclude=minutely,hourly,daily,flags';
const mapLinkBase = 'https://www.google.com/maps/?q=';
const darkSkySecret = process.env.DARK_SKY_SECRET;
const googleApiKey = process.env.SS_GOOGLE_API_KEY;

const COMMENT_ADDED_TOPIC = 'commentAdded';

// Geocode a place through node-geocoder and the Google Maps API
// https://github.com/nchaulet/node-geocoder
function getLocation(place) {
  const options = {
    provider: 'google',
    apiKey: googleApiKey,
  };

  const geocoder = NodeGeocoder(options);

  return new Promise((resolve, reject) => {
    geocoder.geocode(place, (err, res) => {
      if (err) {
        reject(err);
      }
      const { city, country } = res[0];
      const lat = res[0].latitude;
      const lng = res[0].longitude;
      resolve({
        city,
        country,
        coords: [lat, lng],
        mapLink: `${mapLinkBase}${lat},${lng}`,
      });
    });
  });
}

// Pass the geographic coordinates of the location to the Dark Sky API to get current conditions
function getWeather(coords) {
  return new Promise((resolve, reject) => {
    request(`${baseUrl}${darkSkySecret}/${coords[0]},${coords[1]}${urlParams}`, (error, response, body) => {
      if (error) {
        reject(error);
      }
      const data = JSON.parse(body);
      const { summary, temperature } = data.currently;
      resolve({
        summary,
        temperature,
        coords,
      });
    });
  });
}

const rootResolvers = {
  Query: {
    feed(root, { type, offset, limit }, context, { cacheControl }) {
      // Ensure API consumer can only fetch 20 items at most
      cacheControl.setCacheHint({ maxAge: 60 });
      const protectedLimit = (limit < 1 || limit > 20) ? 20 : limit;

      return context.Entries.getForFeed(type, offset, protectedLimit);
    },
    entry(root, { repoFullName }, context, { cacheControl }) {
      cacheControl.setCacheHint({ maxAge: 60 });
      return context.Entries.getByRepoFullName(repoFullName);
    },
    currentUser(root, args, context, { cacheControl }) {
      cacheControl.setCacheHint({ maxAge: 60 });
      return context.user || null;
    },
  },
  Mutation: {
    submitRepository(root, { repoFullName }, context) {
      if (!context.user) {
        throw new Error('Must be logged in to submit a repository.');
      }

      return Promise.resolve()
        .then(() => (
          context.Repositories.getByFullName(repoFullName)
            .then((res) => {
              if (!res) {
                throw new Error(`Couldn't find repository named "${repoFullName}"`);
              }
            })
        ))
        .then(() => (
          context.Entries.getByRepoFullName(repoFullName)
            .then((res) => {
              if (res) {
                throw new Error('This repository has already been added.');
              }
            })
        ))
        .then(() => (
          context.Entries.submitRepository(repoFullName, context.user.login)
        ))
        .then(() => context.Entries.getByRepoFullName(repoFullName));
    },

    submitComment(root, { repoFullName, commentContent }, context) {
      if (!context.user) {
        throw new Error('Must be logged in to submit a comment.');
      }
      return Promise.resolve()
        .then(() => (
          context.Comments.submitComment(
            repoFullName,
            context.user.login,
            commentContent,
          )
        ))
        .then(([id]) => context.Comments.getCommentById(id))
        .then((comment) => {
          // publish subscription notification
          pubsub.publish(COMMENT_ADDED_TOPIC, { commentAdded: comment });

          return comment;
        });
    },

    vote(root, { repoFullName, type }, context) {
      if (!context.user) {
        throw new Error('Must be logged in to vote.');
      }

      const voteValue = {
        UP: 1,
        DOWN: -1,
        CANCEL: 0,
      }[type];

      return context.Entries.voteForEntry(
        repoFullName,
        voteValue,
        context.user.login,
      ).then(() => (
        context.Entries.getByRepoFullName(repoFullName)
      ));
    },
  },
  Subscription: {
    commentAdded: {
      subscribe: withFilter(() => pubsub.asyncIterator(COMMENT_ADDED_TOPIC), (payload, args) => {
        return payload.commentAdded.repository_name === args.repoFullName;
      }),
    },
  },
  User: {
    location(root) {
      return getLocation(root.location);
    },
  },
  Location: {
    weather(root) {
      return getWeather(root.coords);
    },
  },
};

// Put schema together into one array of schema strings
// and one map of resolvers, like makeExecutableSchema expects
const schema = [...rootSchema, ...gitHubSchema, ...sqlSchema];
const resolvers = merge(rootResolvers, gitHubResolvers, sqlResolvers);

const executableSchema = makeExecutableSchema({
  typeDefs: schema,
  resolvers,
});

export default executableSchema;
