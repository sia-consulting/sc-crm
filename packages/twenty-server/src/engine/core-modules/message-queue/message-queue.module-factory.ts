import { DefaultAzureCredential } from '@azure/identity';
import { Client } from 'pg';

import { EnvironmentService } from 'src/engine/core-modules/environment/environment.service';
import {
  BullMQDriverFactoryOptions,
  MessageQueueDriverType,
  MessageQueueModuleOptions,
  PgBossDriverFactoryOptions,
  SyncDriverFactoryOptions,
} from 'src/engine/core-modules/message-queue/interfaces';
import { RedisClientService } from 'src/engine/core-modules/redis-client/redis-client.service';
import { extractUsernameFromToken } from 'src/engine/utils/azure.util';

let azureCredential: DefaultAzureCredential | undefined = undefined;

/**
 * MessageQueue Module factory
 * @returns MessageQueueModuleOptions
 * @param environmentService
 */
export const messageQueueModuleFactory = async (
  environmentService: EnvironmentService,
  redisClientService: RedisClientService,
): Promise<MessageQueueModuleOptions> => {
  azureCredential = environmentService.get(
    'PG_DATABASE_USE_AZURE_MANAGED_IDENTITY',
  )
    ? new DefaultAzureCredential({
        tenantId:
          environmentService.get('AZURE_MANAGED_IDENTITY_TENANT_ID') ||
          environmentService.get('PG_AZURE_MANAGED_IDENTITY_TENANT_ID'),
        managedIdentityClientId:
          environmentService.get('AZURE_MANAGED_IDENTITY_CLIENT_ID') ||
          environmentService.get('PG_AZURE_MANAGED_IDENTITY_CLIENT_ID'),
      })
    : undefined;
  const driverType = environmentService.get('MESSAGE_QUEUE_TYPE');

  switch (driverType) {
    case MessageQueueDriverType.Sync: {
      return {
        type: MessageQueueDriverType.Sync,
        options: {},
      } satisfies SyncDriverFactoryOptions;
    }
    case MessageQueueDriverType.PgBoss: {
      const dateSourceBaseOptions =
        await getDataSourceBaseOptions(environmentService);

      return {
        type: MessageQueueDriverType.PgBoss,
        options: {
          ...dateSourceBaseOptions,
        },
      } satisfies PgBossDriverFactoryOptions;
    }
    case MessageQueueDriverType.BullMQ: {
      return {
        type: MessageQueueDriverType.BullMQ,
        options: {
          connection: (await redisClientService.getClient()) ?? undefined,
        },
      } satisfies BullMQDriverFactoryOptions;
    }
    default:
      throw new Error(
        `Invalid message queue driver type (${driverType}), check your .env file`,
      );
  }
};

const getDataSourceBaseOptions = async (
  environmentService: EnvironmentService,
) => {
  const azureAccessToken = azureCredential
    ? await azureCredential.getToken(
        'https://ossrdbms-aad.database.windows.net/.default',
      )
    : undefined;

  return azureAccessToken
    ? {
        password: azureAccessToken.token,
        username: extractUsernameFromToken(azureAccessToken, 'upn'),
        database: environmentService.get('PG_DATABASE_NAME'),
        host: environmentService.get('PG_DATABASE_HOST'),
        port:
          (environmentService.get('PG_DATABASE_PORT') as number | undefined) ||
          5432,
        schema: environmentService.get('PG_DATABASE_SCHEMA'),
        ssl: true,
        //TypeORM TypeDef are incorrect, see https://github.com/typeorm/typeorm/issues/6350#issuecomment-2431151266
        poolErrorHandler: async (error, client: Client) => {
          if (azureCredential) {
            const azureAccessToken = await azureCredential.getToken(
              'https://ossrdbms-aad.database.windows.net/.default',
            );

            client.user = extractUsernameFromToken(azureAccessToken, 'upn');
            client.password = azureAccessToken?.token;

            await client.connect((connectionError) => {
              if (connectionError) {
                throw connectionError;
              }
            });
          } else {
            throw error;
          }
        },
      }
    : {
        url: process.env.PG_DATABASE_URL,
        ssl:
          process.env.PG_SSL_ALLOW_SELF_SIGNED === 'true'
            ? {
                rejectUnauthorized: false,
              }
            : undefined,
      };
};
