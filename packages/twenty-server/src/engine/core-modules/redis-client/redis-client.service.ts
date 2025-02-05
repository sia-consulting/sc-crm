import { Injectable, OnModuleDestroy } from '@nestjs/common';

import { DefaultAzureCredential } from '@azure/identity';
import IORedis, { RedisOptions } from 'ioredis';
import { createClient, RedisClientType } from 'redis';
import { Semaphore } from 'await-semaphore';

import { EnvironmentService } from 'src/engine/core-modules/environment/environment.service';
import { extractUsernameFromToken } from 'src/engine/utils/azure.util';

@Injectable()
export class RedisClientService implements OnModuleDestroy {
  private redisClient: IORedis | null;
  private nodeRedisClient: RedisClientType | null;
  private tokenUpdateTimeout: NodeJS.Timeout;
  private semaphore: Semaphore;

  constructor(private readonly environmentService: EnvironmentService) {
    this.semaphore = new Semaphore(1);
  }

  async getClient() {
    if (!this.redisClient) {
      const redisUrl = this.environmentService.get('REDIS_URL');

      if (!redisUrl) {
        throw new Error('REDIS_URL must be defined');
      }

      await this.updateClients(redisUrl);
    }

    return this.redisClient;
  }

  async getNodeRedisClient() {
    const semaphoreRelease = await this.semaphore.acquire();

    try {
      if (!this.nodeRedisClient) {
        const redisUrl = this.environmentService.get('REDIS_URL');

        if (!redisUrl) {
          throw new Error('REDIS_URL must be defined');
        }

        await this.updateClients(redisUrl);
      }
    } finally {
      semaphoreRelease();
    }

    return this.nodeRedisClient;
  }

  async updateClients(redisUrl: string) {
    const useAzureManagedIdentity = this.environmentService.get(
      'REDIS_USE_AZURE_MANAGED_IDENTITY',
    );

    let azureRedisOptions: {
      username?: string;
      password?: string;
      tls?: boolean;
      socket?: { tls?: boolean };
      pingInterval?: number;
    } = {};

    if (useAzureManagedIdentity) {
      const azureClientId =
        this.environmentService.get('AZURE_MANAGED_IDENTITY_CLIENT_ID') ||
        this.environmentService.get('REDIS_AZURE_MANAGED_IDENTITY_CLIENT_ID');
      const azureTenantId =
        this.environmentService.get('AZURE_MANAGED_IDENTITY_TENANT_ID') ||
        this.environmentService.get('REDIS_AZURE_MANAGED_IDENTITY_TENANT_ID');
      const azureCredential = new DefaultAzureCredential({
        tenantId: azureTenantId,
        managedIdentityClientId: azureClientId,
      });

      const accessToken = await azureCredential.getToken(
        'https://redis.azure.com/.default',
      );
      const username = extractUsernameFromToken(accessToken);

      if (username) {
        azureRedisOptions = {
          username: username,
          password: accessToken.token,
          tls: true as any,
          socket: {
            tls: true,
          },
          pingInterval: 10000,
        };
      }

      const randomTimestamp = this.randomNumber(120000, 300000);

      this.tokenUpdateTimeout = setTimeout(
        async (redisUrl) => {
          await this.updateClients(redisUrl);
        },
        accessToken.expiresOnTimestamp - randomTimestamp - Date.now(),
        redisUrl,
        true,
      );
    }
    this.redisClient = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      ...azureRedisOptions,
    } as RedisOptions);

    if (this.nodeRedisClient && this.nodeRedisClient.options) {
      this.nodeRedisClient.options.username = azureRedisOptions.username;
      this.nodeRedisClient.options.password = azureRedisOptions.password;
      if (
        this.nodeRedisClient.isOpen &&
        azureRedisOptions.username &&
        azureRedisOptions.password
      ) {
        await this.nodeRedisClient.auth({
          username: azureRedisOptions.username,
          password: azureRedisOptions.password,
        });
      }
    } else {
      this.nodeRedisClient = await createClient({
        ...azureRedisOptions,
        url: redisUrl,
      });
      this.nodeRedisClient.on('error', (error) => {
        console.error('==========> Redis error:', typeof error);
      });
      await this.nodeRedisClient.connect();
    }
  }

  randomNumber(min: number, max: number) {
    min = Math.ceil(min);
    max = Math.floor(max);

    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async onModuleDestroy() {
    if (this.redisClient) {
      await this.redisClient.quit();
      this.redisClient = null;
    }
    if (this.tokenUpdateTimeout) {
      clearTimeout(this.tokenUpdateTimeout);
    }
  }
}
