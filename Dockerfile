FROM mcr.microsoft.com/playwright:v1.51.1-noble

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts

COPY . ./

ENV APIFY_LOCAL_STORAGE_DIR=/tmp/storage

CMD ["node", "src/main.js"]
