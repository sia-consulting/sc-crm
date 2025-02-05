import { CacheModuleOptions } from '@nestjs/common';

import { redisInsStore } from 'cache-manager-redis-yet';

import { CacheStorageType } from 'src/engine/core-modules/cache-storage/types/cache-storage-type.enum';
import { EnvironmentService } from 'src/engine/core-modules/environment/environment.service';
import { RedisClientService } from 'src/engine/core-modules/redis-client/redis-client.service';

export const cacheStorageModuleFactory = async (
  environmentService: EnvironmentService,
  redisService: RedisClientService,
): Promise<CacheModuleOptions> => {
  const cacheStorageType = environmentService.get('CACHE_STORAGE_TYPE');
  const cacheStorageTtl = environmentService.get('CACHE_STORAGE_TTL');
  const cacheModuleOptions: CacheModuleOptions = {
    isGlobal: true,
    ttl: cacheStorageTtl * 1000,
  };

  switch (cacheStorageType) {
    case CacheStorageType.Memory: {
      return cacheModuleOptions;
    }
    case CacheStorageType.Redis: {
      const redisUrl = environmentService.get('REDIS_URL');

      if (!redisUrl) {
        throw new Error(
          `cache storage requires REDIS_URL to be defined, check your .env file`,
        );
      }

      const redisClient = await redisService.getNodeRedisClient();

      if (!redisClient) {
        throw new Error('could not create cache storage client');
      }

      return {
        ...cacheModuleOptions,
        store: await redisInsStore(redisClient, {
          ...cacheModuleOptions,
        }),
      };
    }
    default:
      throw new Error(
        `Invalid cache-storage (${cacheStorageType}), check your .env file`,
      );
  }
};
