import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://demos.dallascrilley.com',
  output: 'static',
  build: { format: 'directory' },
});
