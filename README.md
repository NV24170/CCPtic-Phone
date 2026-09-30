# CCPtic Phone

A real-time multiplayer drawing and guessing game. The Node server hosts the page, rooms, chat, round state, and shared album reveal over Socket.IO.

## Run locally

```sh
npm install
npm start
```

Open `http://localhost:3000` in multiple browsers or devices to join the same room. The health endpoint is `http://localhost:3000/health`.

## Deploy to Render

Create a new Render Blueprint from this repository. Render reads `render.yaml`, installs the dependencies, and starts the web service. The assigned `PORT` is used automatically, and `/health` is configured as the health check. Room state is held in memory, so active rooms reset when the service restarts.