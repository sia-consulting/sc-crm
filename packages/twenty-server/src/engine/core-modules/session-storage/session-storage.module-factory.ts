import { Logger } from '@nestjs/common';

import RedisStore from 'connect-redis';
import session from 'express-session';

import { EnvironmentService } from 'src/engine/core-modules/environment/environment.service';
import { CacheStorageType } from 'src/engine/core-modules/cache-storage/types/cache-storage-type.enum';
import { RedisClientService } from 'src/engine/core-modules/redis-client/redis-client.service';

export const getSessionStorageOptions = async (
  environmentService: EnvironmentService,
  redisService: RedisClientService,
): Promise<session.SessionOptions> => {
  const cacheStorageType = environmentService.get('CACHE_STORAGE_TYPE');

  const SERVER_URL = environmentService.get('SERVER_URL');

  const sessionStorage: session.SessionOptions = {
    secret: environmentService.get('SESSION_STORE_SECRET'),
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      secure: !!(SERVER_URL && SERVER_URL.startsWith('https')),
      maxAge: 1000 * 60 * 30, // 30 minutes
    },
  };

  switch (cacheStorageType) {
    case CacheStorageType.Memory: {
      Logger.warn(
        'Memory session storage is not recommended for production. Prefer Redis.',
      );

      return sessionStorage;
    }
    case CacheStorageType.Redis: {
      const connectionString = environmentService.get('REDIS_URL');

      if (!connectionString) {
        throw new Error(
          `${CacheStorageType.Redis} session storage requires REDIS_URL to be defined, check your .env file`,
        );
      }

      const redisClient = await redisService.getClient();

      if (!redisClient) {
        throw new Error(
          `${CacheStorageType.Redis} could not create sessionstorage client`,
        );
      }

      return {
        ...sessionStorage,
        store: new RedisStore({
          client: redisClient,
          prefix: 'engine:session:',
        }),
      };
    }
    default:
      throw new Error(
        `Invalid session-storage (${cacheStorageType}), check your .env file`,
      );
  }
};
