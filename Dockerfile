FROM apify/actor-node-playwright-chrome:20

COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY . ./
