FROM node:22-alpine AS build
WORKDIR /source
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /source/dist /usr/share/nginx/html
EXPOSE 80
