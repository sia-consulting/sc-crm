import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAzureManagedIdentityMetadata1738625945258 implements MigrationInterface {
    name = 'AddAzureManagedIdentityMetadata1738625945258'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "metadata"."dataSource" ADD "host" character varying`);
        await queryRunner.query(`ALTER TABLE "metadata"."dataSource" ADD "port" integer`);
        await queryRunner.query(`ALTER TABLE "metadata"."dataSource" ADD "username" character varying`);
        await queryRunner.query(`ALTER TABLE "metadata"."dataSource" ADD "database" character varying`);
        await queryRunner.query(`ALTER TABLE "metadata"."dataSource" ADD "useAzureManagedIdentity" boolean`);
        await queryRunner.query(`ALTER TABLE "metadata"."dataSource" ADD "azureManagedIdentityClientId" character varying`);
        await queryRunner.query(`ALTER TABLE "metadata"."dataSource" ADD "azureManagedIdentityTenantId" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "metadata"."dataSource" DROP COLUMN "azureManagedIdentityTenantId"`);
        await queryRunner.query(`ALTER TABLE "metadata"."dataSource" DROP COLUMN "azureManagedIdentityClientId"`);
        await queryRunner.query(`ALTER TABLE "metadata"."dataSource" DROP COLUMN "useAzureManagedIdentity"`);
        await queryRunner.query(`ALTER TABLE "metadata"."dataSource" DROP COLUMN "database"`);
        await queryRunner.query(`ALTER TABLE "metadata"."dataSource" DROP COLUMN "username"`);
        await queryRunner.query(`ALTER TABLE "metadata"."dataSource" DROP COLUMN "port"`);
        await queryRunner.query(`ALTER TABLE "metadata"."dataSource" DROP COLUMN "host"`);
    }

}
