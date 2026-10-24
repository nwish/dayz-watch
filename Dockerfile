FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server.js"]
