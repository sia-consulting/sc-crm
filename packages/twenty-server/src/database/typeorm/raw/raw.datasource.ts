import { AccessToken, DefaultAzureCredential } from '@azure/identity';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { Client } from 'pg';

import { extractUsernameFromToken } from 'src/engine/utils/azure.util';
config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env' });

let dataSource: DataSource;
const getAzureCredential = () =>
  process.env.PG_DATABASE_USE_AZURE_MANAGED_IDENTITY === 'true'
    ? new DefaultAzureCredential({
        tenantId:
          process.env.AZURE_MANAGED_IDENTITY_TENANT_ID ||
          process.env.PG_AZURE_MANAGED_IDENTITY_TENANT_ID,
        managedIdentityClientId:
          process.env.AZURE_MANAGED_IDENTITY_CLIENT_ID ||
          process.env.PG_AZURE_MANAGED_IDENTITY_CLIENT_ID,
      })
    : undefined;

export const rawDataSource = async () => {
  if (!dataSource) {
    dataSource = await initRawDataSource();
  }

  return dataSource;
};

const initRawDataSource = async () => {
  const azureCredential = getAzureCredential();
  const azureAccessToken = azureCredential
    ? await azureCredential.getToken(
        'https://ossrdbms-aad.database.windows.net/.default',
      )
    : undefined;
  const dataSourceBaseOptions = getDataSourceBaseOptions(azureAccessToken);

  //@ts-expect-error - TypeORM TypeDef are incorrect, see https://github.com/typeorm/typeorm/issues/6350#issuecomment-2431151266
  return new DataSource({
    ...dataSourceBaseOptions,
    type: 'postgres',
    logging: ['error'],
  });
};

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
        schema: process.env.PG_DATABASE_SCHEMA,
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
