import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  app.enableCors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000' });
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(`APIWatch API listening on http://localhost:${port}/api/v1`);
}
await bootstrap();
