import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  DataSourceOptions,
  OneToMany,
} from 'typeorm';

import { ObjectMetadataEntity } from 'src/engine/metadata-modules/object-metadata/object-metadata.entity';

export type DataSourceType = DataSourceOptions['type'];

@Entity('dataSource')
export class DataSourceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  label: string;

  @Column({ nullable: true })
  url: string;

  @Column({ nullable: true })
  host: string;

  @Column({ nullable: true })
  port: number;

  @Column({ nullable: true })
  username: string;

  @Column({ nullable: true })
  database: string;

  @Column({ nullable: true })
  useAzureManagedIdentity: boolean;

  @Column({ nullable: true })
  azureManagedIdentityClientId: string;

  @Column({ nullable: true })
  azureManagedIdentityTenantId: string;

  @Column({ nullable: true })
  schema: string;

  @Column({ type: 'enum', enum: ['postgres'], default: 'postgres' })
  type: DataSourceType;

  @Column({ default: false })
  isRemote: boolean;

  @OneToMany(() => ObjectMetadataEntity, (object) => object.dataSource, {
    cascade: true,
  })
  objects: ObjectMetadataEntity[];

  @Column({ nullable: false, type: 'uuid' })
  workspaceId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
