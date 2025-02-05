import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { AccessToken, DefaultAzureCredential } from '@azure/identity';
import { config } from 'dotenv';
import { DataSource, DataSourceOptions } from 'typeorm';
import { Client } from 'pg';

import { extractUsernameFromToken } from 'src/engine/utils/azure.util';
config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

const isJest = process.argv.some((arg) => arg.includes('jest'));

const getAzureCredential = () => {
  return process.env.PG_DATABASE_USE_AZURE_MANAGED_IDENTITY === 'true'
    ? new DefaultAzureCredential({
        tenantId:
          process.env.AZURE_MANAGED_IDENTITY_TENANT_ID ||
          process.env.PG_AZURE_MANAGED_IDENTITY_TENANT_ID,
        managedIdentityClientId:
          process.env.AZURE_MANAGED_IDENTITY_CLIENT_ID ||
          process.env.PG_AZURE_MANAGED_IDENTITY_CLIENT_ID,
      })
    : undefined;
};

export const getTypeORMCoreModuleOptions =
  async (): Promise<TypeOrmModuleOptions> => {
    const azureCredential = getAzureCredential();
    const azureAccessToken = azureCredential
      ? await azureCredential.getToken(
          'https://ossrdbms-aad.database.windows.net/.default',
        )
      : undefined;
    const dataSourceBaseOptions = getDataSourceBaseOptions(azureAccessToken);

    //@ts-expect-error - TypeORM TypeDef are incorrect, see https://github.com/typeorm/typeorm/issues/6350#issuecomment-2431151266
    return {
      ...dataSourceBaseOptions,
      type: 'postgres',
      logging: ['error'],
      schema: 'core',
      entities:
        process.env.IS_BILLING_ENABLED === 'true'
          ? [
              `${isJest ? '' : 'dist/'}src/engine/core-modules/**/*.entity{.ts,.js}`,
            ]
          : [
              `${isJest ? '' : 'dist/'}src/engine/core-modules/**/!(billing-*).entity{.ts,.js}`,
            ],
      synchronize: false,
      migrationsRun: false,
      migrationsTableName: '_typeorm_migrations',
      metadataTableName: '_typeorm_generated_columns_and_materialized_views',
      migrations:
        process.env.IS_BILLING_ENABLED === 'true'
          ? [
              `${isJest ? '' : 'dist/'}src/database/typeorm/core/migrations/common/*{.ts,.js}`,
              `${isJest ? '' : 'dist/'}src/database/typeorm/core/migrations/billing/*{.ts,.js}`,
            ]
          : [
              `${isJest ? '' : 'dist/'}src/database/typeorm/core/migrations/common/*{.ts,.js}`,
            ],
    };
  };

export const connectionSource: Promise<DataSource> = new Promise(
  (resolve, reject) => {
    getTypeORMCoreModuleOptions()
      .then((options) => {
        resolve(new DataSource(options as DataSourceOptions));
      })
      .catch((error) => {
        reject(error);
      });
  },
);

const getDataSourceBaseOptions = (
  azureAccessToken: AccessToken | undefined,
) => {
  return azureAccessToken
    ? {
        password: azureAccessToken.token,
        username: extractUsernameFromToken(azureAccessToken, 'upn'),
        database: process.env.PG_DATABASE_NAME,
        host: process.env.PG_DATABASE_HOST,
        port: (process.env.PG_DATABASE_PORT as number | undefined) || 5432,
        ssl: true,
        //TypeORM TypeDef are incorrect, see https://github.com/typeorm/typeorm/issues/6350#issuecomment-2431151266
        poolErrorHandler: async (error, client: Client) => {
          const azureCredential = getAzureCredential();

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
