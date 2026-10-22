import { INestApplication, ValidationPipe } from '@nestjs/common';

/** Shared by main.ts and the e2e tests so they behave identically. */
export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown fields (stops clients setting teamId, currentStatus, ...)
      forbidNonWhitelisted: true, // ...and tell them about it
      transform: true,
    }),
  );
}
