import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { DataSource } from 'typeorm';
import { AccessToken, DefaultAzureCredential } from '@azure/identity';
import { Client } from 'pg';

import { AppToken } from 'src/engine/core-modules/app-token/app-token.entity';
import { BillingCustomer } from 'src/engine/core-modules/billing/entities/billing-customer.entity';
import { BillingEntitlement } from 'src/engine/core-modules/billing/entities/billing-entitlement.entity';
import { BillingMeter } from 'src/engine/core-modules/billing/entities/billing-meter.entity';
import { BillingPrice } from 'src/engine/core-modules/billing/entities/billing-price.entity';
import { BillingProduct } from 'src/engine/core-modules/billing/entities/billing-product.entity';
import { BillingSubscriptionItem } from 'src/engine/core-modules/billing/entities/billing-subscription-item.entity';
import { BillingSubscription } from 'src/engine/core-modules/billing/entities/billing-subscription.entity';
import { EnvironmentService } from 'src/engine/core-modules/environment/environment.service';
import { FeatureFlag } from 'src/engine/core-modules/feature-flag/feature-flag.entity';
import { KeyValuePair } from 'src/engine/core-modules/key-value-pair/key-value-pair.entity';
import { PostgresCredentials } from 'src/engine/core-modules/postgres-credentials/postgres-credentials.entity';
import { WorkspaceSSOIdentityProvider } from 'src/engine/core-modules/sso/workspace-sso-identity-provider.entity';
import { TwoFactorMethod } from 'src/engine/core-modules/two-factor-method/two-factor-method.entity';
import { UserWorkspace } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { User } from 'src/engine/core-modules/user/user.entity';
import { Workspace } from 'src/engine/core-modules/workspace/workspace.entity';
import { DataSourceEntity } from 'src/engine/metadata-modules/data-source/data-source.entity';
import { extractUsernameFromToken } from 'src/engine/utils/azure.util';

let azureCredential: DefaultAzureCredential | undefined;

@Injectable()
export class TypeORMService implements OnModuleInit, OnModuleDestroy {
  private dataSources: Map<string, DataSource> = new Map();
  private isDatasourceInitializing: Map<string, boolean> = new Map();
  private azureAccessToken: AccessToken | undefined;
  private mainDataSource: DataSource;

  constructor(private readonly environmentService: EnvironmentService) {
    const clientId =
      this.environmentService.get('AZURE_MANAGED_IDENTITY_CLIENT_ID') ||
      this.environmentService.get('PG_AZURE_MANAGED_IDENTITY_CLIENT_ID');
    const tenantId =
      this.environmentService.get('AZURE_MANAGED_IDENTITY_TENANT_ID') ||
      this.environmentService.get('PG_AZURE_MANAGED_IDENTITY_TENANT_ID');

    if (this.environmentService.get('PG_DATABASE_USE_AZURE_MANAGED_IDENTITY')) {
      azureCredential = new DefaultAzureCredential({
        tenantId: tenantId,
        managedIdentityClientId: clientId,
      });
    }
  }

  public async connectToDataSource(
    dataSource: DataSourceEntity,
  ): Promise<DataSource | undefined> {
    const isMultiDatasourceEnabled = false;

    if (isMultiDatasourceEnabled) {
      // Wait for a bit before trying again if another initialization is in progress
      while (this.isDatasourceInitializing.get(dataSource.id)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      if (this.dataSources.has(dataSource.id)) {
        return this.dataSources.get(dataSource.id);
      }

      this.isDatasourceInitializing.set(dataSource.id, true);

      try {
        const dataSourceInstance =
          await this.createAndInitializeDataSource(dataSource);

        this.dataSources.set(dataSource.id, dataSourceInstance);

        return dataSourceInstance;
      } finally {
        this.isDatasourceInitializing.delete(dataSource.id);
      }
    }

    return await this.getMainDataSource();
  }

  public async getMainDataSource(): Promise<DataSource> {
    await this.setAzureAccessToken();

    return this.mainDataSource;
  }

  private async setAzureAccessToken() {
    if (!this.mainDataSource) {
      const dataSourceBaseOptions = await this.getDataSourceBaseOptions();

      //@ts-expect-error - TypeORM TypeDef are incorrect, see https://github.com/typeorm/typeorm/issues/6350#issuecomment-2431151266
      this.mainDataSource = new DataSource({
        ...dataSourceBaseOptions,
        type: 'postgres',
        logging: false,
        schema: 'core',
        entities: [
          User,
          Workspace,
          UserWorkspace,
          AppToken,
          KeyValuePair,
          FeatureFlag,
          BillingSubscription,
          BillingSubscriptionItem,
          BillingMeter,
          BillingCustomer,
          BillingProduct,
          BillingPrice,
          BillingEntitlement,
          PostgresCredentials,
          WorkspaceSSOIdentityProvider,
          TwoFactorMethod,
        ],
        metadataTableName: '_typeorm_generated_columns_and_materialized_views',
        extra: {
          query_timeout: 10000,
        },
      });
    }
  }

  private async createAndInitializeDataSource(
    dataSource: DataSourceEntity,
  ): Promise<DataSource> {
    const schema = dataSource.schema;

    const dataSourceBaseOptions = await this.getDataSourceBaseOptions();

    //@ts-expect-error - TypeORM TypeDef are incorrect, see https://github.com/typeorm/typeorm/issues/6350#issuecomment-2431151266
    const workspaceDataSource = new DataSource({
      ...dataSourceBaseOptions,
      type: 'postgres',
      logging: this.environmentService.get('DEBUG_MODE')
        ? ['query', 'error']
        : ['error'],
      schema,
    });

    await workspaceDataSource.initialize();

    return workspaceDataSource;
  }

  public async disconnectFromDataSource(dataSourceId: string) {
    if (!this.dataSources.has(dataSourceId)) {
      return;
    }

    const dataSource = this.dataSources.get(dataSourceId);

    await dataSource?.destroy();

    this.dataSources.delete(dataSourceId);
  }

  public async createSchema(schemaName: string): Promise<string> {
    const queryRunner = (await this.getMainDataSource()).createQueryRunner();

    await queryRunner.createSchema(schemaName, true);

    await queryRunner.release();

    return schemaName;
  }

  public async deleteSchema(schemaName: string) {
    const queryRunner = (await this.getMainDataSource()).createQueryRunner();

    await queryRunner.dropSchema(schemaName, true, true);

    await queryRunner.release();
  }

  async onModuleInit() {
    // Init main data source "default" schema
    await (await this.getMainDataSource()).initialize();
  }

  async onModuleDestroy() {
    // Destroy main data source "default" schema
    await (await this.getMainDataSource()).destroy();

    // Destroy all workspace data sources
    for (const [, dataSource] of this.dataSources) {
      await dataSource.destroy();
    }
  }

  private async getDataSourceBaseOptions() {
    await this.initAzureAccessToken();

    return azureCredential
      ? {
          password: this.azureAccessToken?.token,
          username: extractUsernameFromToken(this.azureAccessToken, 'upn'),
          database: this.environmentService.get('PG_DATABASE_NAME'),
          host: this.environmentService.get('PG_DATABASE_HOST'),
          port: this.environmentService.get('PG_DATABASE_PORT'),
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
          url: this.environmentService.get('PG_DATABASE_URL'),
          ssl: this.environmentService.get('PG_SSL_ALLOW_SELF_SIGNED')
            ? {
                rejectUnauthorized: false,
              }
            : undefined,
        };
  }

  private async initAzureAccessToken() {
    if (azureCredential) {
      this.azureAccessToken = await azureCredential.getToken(
        'https://ossrdbms-aad.database.windows.net/.default',
      );
    }
  }
}
