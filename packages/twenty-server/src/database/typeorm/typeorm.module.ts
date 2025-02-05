import { Module } from '@nestjs/common';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';

import { getTypeORMCoreModuleOptions } from 'src/database/typeorm/core/core.datasource';
import { EnvironmentModule } from 'src/engine/core-modules/environment/environment.module';

import { TypeORMService } from './typeorm.service';

import { getTypeORMMetadataModuleOptions } from './metadata/metadata.datasource';

const metadataTypeORMFactory = async (): Promise<TypeOrmModuleOptions> => ({
  ...(await getTypeORMMetadataModuleOptions()),
  name: 'metadata',
});

const coreTypeORMFactory = async (): Promise<TypeOrmModuleOptions> => ({
  ...(await getTypeORMCoreModuleOptions()),
  name: 'core',
});

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: metadataTypeORMFactory,
      name: 'metadata',
    }),
    TypeOrmModule.forRootAsync({
      useFactory: coreTypeORMFactory,
      name: 'core',
    }),
    EnvironmentModule,
  ],
  providers: [TypeORMService],
  exports: [TypeORMService],
})
export class TypeORMModule {}
