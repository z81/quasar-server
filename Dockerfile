FROM node:25

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
RUN ["npm", "-g", "i", "pnpm@10.23.0"]
COPY ./package.json ./pnpm-lock.yaml ./pnpm-workspace.yaml ./
RUN ["pnpm", "install", "--frozen-lockfile"]
COPY . .
CMD ["pnpm", "start"]