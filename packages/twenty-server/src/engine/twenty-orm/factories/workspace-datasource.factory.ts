import { Injectable, Logger } from '@nestjs/common';

import { EntitySchema } from 'typeorm';
import { DefaultAzureCredential } from '@azure/identity';
import { Client } from 'pg';

import { EnvironmentService } from 'src/engine/core-modules/environment/environment.service';
import { DataSourceService } from 'src/engine/metadata-modules/data-source/data-source.service';
import { WorkspaceMetadataCacheService } from 'src/engine/metadata-modules/workspace-metadata-cache/services/workspace-metadata-cache.service';
import { WorkspaceDataSource } from 'src/engine/twenty-orm/datasource/workspace.datasource';
import {
  TwentyORMException,
  TwentyORMExceptionCode,
} from 'src/engine/twenty-orm/exceptions/twenty-orm.exception';
import { EntitySchemaFactory } from 'src/engine/twenty-orm/factories/entity-schema.factory';
import { CacheManager } from 'src/engine/twenty-orm/storage/cache-manager.storage';
import { WorkspaceCacheStorageService } from 'src/engine/workspace-cache-storage/workspace-cache-storage.service';
import { DataSourceEntity } from 'src/engine/metadata-modules/data-source/data-source.entity';
import { extractUsernameFromToken } from 'src/engine/utils/azure.util';

let azureCredential: DefaultAzureCredential | undefined;

@Injectable()
export class WorkspaceDatasourceFactory {
  private readonly logger = new Logger(WorkspaceDatasourceFactory.name);
  private cacheManager = new CacheManager<WorkspaceDataSource>();
  private cachedDatasourcePromise: Record<string, Promise<WorkspaceDataSource>>;

  constructor(
    private readonly dataSourceService: DataSourceService,
    private readonly environmentService: EnvironmentService,
    private readonly workspaceCacheStorageService: WorkspaceCacheStorageService,
    private readonly workspaceMetadataCacheService: WorkspaceMetadataCacheService,
    private readonly entitySchemaFactory: EntitySchemaFactory,
  ) {
    this.cachedDatasourcePromise = {};
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
  }

  public async create(
    workspaceId: string,
    workspaceMetadataVersion: number | null,
    failOnMetadataCacheMiss = true,
  ): Promise<WorkspaceDataSource> {
    const cachedWorkspaceMetadataVersion =
      await this.getWorkspaceMetadataVersionFromCache(
        workspaceId,
        failOnMetadataCacheMiss,
      );

    if (
      workspaceMetadataVersion !== null &&
      cachedWorkspaceMetadataVersion !== workspaceMetadataVersion
    ) {
      throw new TwentyORMException(
        `Workspace metadata version mismatch detected for workspace ${workspaceId}. Current version: ${cachedWorkspaceMetadataVersion}. Desired version: ${workspaceMetadataVersion}`,
        TwentyORMExceptionCode.METADATA_VERSION_MISMATCH,
      );
    }

    const cacheKey = `${workspaceId}-${cachedWorkspaceMetadataVersion}`;

    if (cacheKey in this.cachedDatasourcePromise) {
      return this.cachedDatasourcePromise[cacheKey];
    }

    const creationPromise = (async (): Promise<WorkspaceDataSource> => {
      try {
        const result = await this.cacheManager.execute(
          cacheKey as '`${string}-${string}`',
          async () => {
            this.logger.log(
              `Creating workspace data source for workspace ${workspaceId} and metadata version ${cachedWorkspaceMetadataVersion}`,
            );

            const dataSourceMetadata =
              await this.dataSourceService.getLastDataSourceMetadataFromWorkspaceId(
                workspaceId,
              );

            if (!dataSourceMetadata) {
              throw new TwentyORMException(
                `Workspace Schema not found for workspace ${workspaceId}`,
                TwentyORMExceptionCode.WORKSPACE_SCHEMA_NOT_FOUND,
              );
            }

            const cachedEntitySchemaOptions =
              await this.workspaceCacheStorageService.getORMEntitySchema(
                workspaceId,
                cachedWorkspaceMetadataVersion,
              );

            let cachedEntitySchemas: EntitySchema[];

            const cachedObjectMetadataMaps =
              await this.workspaceCacheStorageService.getObjectMetadataMaps(
                workspaceId,
                cachedWorkspaceMetadataVersion,
              );

            if (!cachedObjectMetadataMaps) {
              throw new TwentyORMException(
                `Workspace Schema not found for workspace ${workspaceId}`,
                TwentyORMExceptionCode.METADATA_COLLECTION_NOT_FOUND,
              );
            }

            if (cachedEntitySchemaOptions) {
              cachedEntitySchemas = cachedEntitySchemaOptions.map(
                (option) => new EntitySchema(option),
              );
            } else {
              const entitySchemas = await Promise.all(
                Object.values(cachedObjectMetadataMaps.byId).map(
                  (objectMetadata) =>
                    this.entitySchemaFactory.create(
                      workspaceId,
                      cachedWorkspaceMetadataVersion,
                      objectMetadata,
                      cachedObjectMetadataMaps,
                    ),
                ),
              );

              await this.workspaceCacheStorageService.setORMEntitySchema(
                workspaceId,
                cachedWorkspaceMetadataVersion,
                entitySchemas.map((entitySchema) => entitySchema.options),
              );

              cachedEntitySchemas = entitySchemas;
            }

            const workspaceDataSource = new WorkspaceDataSource(
              {
                workspaceId,
                objectMetadataMaps: cachedObjectMetadataMaps,
              },
              //@ts-expect-error - TypeORM TypeDef are incorrect, see https://github.com/typeorm/typeorm/issues/6350#issuecomment-2431151266
              {
                ...(await this.getWorkspaceDataSourceFromMetadata(
                  dataSourceMetadata,
                )),
                type: 'postgres',
                logging: this.environmentService.get('DEBUG_MODE')
                  ? ['query', 'error']
                  : ['error'],
                schema: dataSourceMetadata.schema,
                entities: cachedEntitySchemas,
              },
            );

            await workspaceDataSource.initialize();

            return workspaceDataSource;
          },
          async (dataSource) => {
            try {
              await dataSource.destroy();
            } catch (error) {
              // Ignore error if pool has already been destroyed which is a common race condition case
              if (error.message === 'Called end on pool more than once') {
                return;
              }

              throw error;
            }
          },
        );

        if (result === null) {
          throw new Error(
            `Failed to create WorkspaceDataSource for ${cacheKey}`,
          );
        }

        return result;
      } finally {
        delete this.cachedDatasourcePromise[cacheKey];
      }
    })();

    this.cachedDatasourcePromise[cacheKey] = creationPromise;

    return creationPromise;
  }

  public async destroy(workspaceId: string): Promise<void> {
    const cachedWorkspaceMetadataVersion =
      await this.workspaceCacheStorageService.getMetadataVersion(workspaceId);

    await this.cacheManager.clearKey(
      `${workspaceId}-${cachedWorkspaceMetadataVersion}`,
    );
  }

  private async getWorkspaceMetadataVersionFromCache(
    workspaceId: string,
    failOnMetadataCacheMiss = true,
  ): Promise<number> {
    let latestWorkspaceMetadataVersion =
      await this.workspaceCacheStorageService.getMetadataVersion(workspaceId);

    if (latestWorkspaceMetadataVersion === undefined) {
      await this.workspaceMetadataCacheService.recomputeMetadataCache({
        workspaceId,
        ignoreLock: !failOnMetadataCacheMiss,
      });

      if (failOnMetadataCacheMiss) {
        throw new TwentyORMException(
          `Metadata version not found for workspace ${workspaceId}`,
          TwentyORMExceptionCode.METADATA_VERSION_NOT_FOUND,
        );
      } else {
        latestWorkspaceMetadataVersion =
          await this.workspaceCacheStorageService.getMetadataVersion(
            workspaceId,
          );
      }
    }

    if (!latestWorkspaceMetadataVersion) {
      throw new TwentyORMException(
        `Metadata version not found after recompute for workspace ${workspaceId}`,
        TwentyORMExceptionCode.METADATA_VERSION_NOT_FOUND,
      );
    }

    return latestWorkspaceMetadataVersion;
  }

  private async getWorkspaceDataSourceFromMetadata(
    workspaceMetadata: DataSourceEntity,
  ) {
    const azureAccessToken = azureCredential
      ? await azureCredential.getToken(
          'https://ossrdbms-aad.database.windows.net/.default',
        )
      : undefined;

    return azureAccessToken?.token
      ? {
          password: azureAccessToken.token,
          username:
            workspaceMetadata.username ||
            extractUsernameFromToken(azureAccessToken, 'upn'),
          database:
            workspaceMetadata.database ||
            this.environmentService.get('PG_DATABASE_NAME'),
          host:
            workspaceMetadata.host ||
            this.environmentService.get('PG_DATABASE_HOST'),
          port:
            (workspaceMetadata.port as number | undefined) ||
            (this.environmentService.get('PG_DATABASE_PORT') as
              | number
              | undefined) ||
            5432,
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
          url:
            workspaceMetadata.url ??
            this.environmentService.get('PG_DATABASE_URL'),
          ssl: this.environmentService.get('PG_SSL_ALLOW_SELF_SIGNED')
            ? {
                rejectUnauthorized: false,
              }
            : undefined,
        };
  }
}
