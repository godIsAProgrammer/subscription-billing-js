FROM node:22-bookworm

WORKDIR /app

COPY repo/ .

EXPOSE 8797

CMD ["npm", "start"]
