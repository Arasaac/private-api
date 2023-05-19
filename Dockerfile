FROM node:14-buster
LABEL maintainer="juandacorreo@gmail.com"

ENV NODE_ENV=production 
ENV PORT=3000 



## see https://github.com/GoogleChrome/puppeteer/blob/master/docs/troubleshooting.md


# Install latest chrome dev package and fonts to support major charsets (Chinese, Japanese, Arabic, Hebrew, Thai and a few others)
# Note: this installs the necessary libs to make the bundled version of Chromium that Puppeteer
# installs, work.
RUN apt-get update \
  && apt-get install -y wget gnupg \
  && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
  && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
  && apt-get update \
  && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# set locale
ENV LC_ALL es_ES.UTF-8
ENV LANG es_ES.UTF-8
ENV LANGUAGE es_ES.UTF-8


# Set working directory
RUN mkdir /app
WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm ci --omit=dev


# Configure entrypoint
COPY entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Bundle app source
COPY . . 

# Run app

EXPOSE $PORT

USER node

# Run this app when a container is launched
# base image entrypoint will add node command
CMD [ "privateapi.js" ]
