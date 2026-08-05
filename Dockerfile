# icegate Node.js target (SPEC §17). The Workers target deploys via
# scripts/deploy.sh; this image is for self-hosting.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json config.yaml ./
COPY src ./src
# Point ICEGATE_CONFIG at a mounted config for real deployments.
ENV PORT=8787
EXPOSE 8787
CMD ["npx", "tsx", "src/node.ts"]
