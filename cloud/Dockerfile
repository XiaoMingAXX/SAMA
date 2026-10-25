ARG SAMA_NODE_IMAGE=public.ecr.aws/docker/library/node:24-trixie-slim
ARG SAMA_RUNTIME_IMAGE=gcr.io/distroless/cc-debian13:nonroot
FROM ${SAMA_NODE_IMAGE} AS dependencies
WORKDIR /app
COPY cloud/package.json cloud/package-lock.json ./cloud/
RUN npm ci --prefix /app/cloud --omit=dev --include=optional --ignore-scripts --no-audit --no-fund && mkdir -p /app/cloud/data-v2

FROM ${SAMA_RUNTIME_IMAGE} AS runtime
WORKDIR /app
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies /usr/local/LICENSE /usr/local/share/licenses/node-LICENSE
COPY --from=dependencies /app/cloud/node_modules ./cloud/node_modules
COPY --from=dependencies /app/cloud/data-v2 ./cloud/data-v2
COPY cloud/package.json cloud/package-lock.json ./cloud/
COPY lib ./lib
COPY cloud/lib ./cloud/lib
COPY cloud/server.mjs ./cloud/server.mjs
COPY cloud/manage.mjs ./cloud/manage.mjs
COPY cloud/preflight-oss.mjs ./cloud/preflight-oss.mjs
COPY cloud/public ./cloud/public
WORKDIR /app/cloud
USER 1001:1001
ENV PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=production HOST=0.0.0.0 PORT=18899 WEB_PORT=18880 CLOUD_DATA_DIR=/app/cloud/data-v2
EXPOSE 18899 18880
ENTRYPOINT []
CMD ["node", "server.mjs"]
