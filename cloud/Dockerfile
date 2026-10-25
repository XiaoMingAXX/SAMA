FROM public.ecr.aws/docker/library/node:20-bookworm-slim
WORKDIR /app
COPY lib ./lib
COPY cloud/package.json ./cloud/package.json
COPY cloud/server.mjs ./cloud/server.mjs
COPY cloud/public ./cloud/public
RUN mkdir -p /app/cloud/data
WORKDIR /app/cloud
ENV HOST=0.0.0.0 PORT=18899 CLOUD_DATA_DIR=/app/cloud/data
EXPOSE 18899
CMD ["node", "server.mjs"]
