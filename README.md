# CCPtic Phone

A real-time, browser-based drawing and guessing game. Rooms, chat, settings, rounds, and album reveals are shared with other players through Socket.IO.

## Run Locally

Requires Node.js 20 or newer.

```sh
npm ci
npm start
```

Open `http://localhost:3000` on each device. Devices must be able to reach the host machine; use its LAN address instead of `localhost` on other devices.

## Deploy to Render

Create a Render Blueprint from this repository and apply [render.yaml](render.yaml), or configure a Node web service with build command `npm ci`, start command `npm start`, and health check path `/health`. Render supplies the port and HTTPS connection; the Socket.IO client connects to the same origin.

The existing Render service address is [ccptic-phone.onrender.com](https://ccptic-phone.onrender.com). Deploy this server-backed version there before sharing it.

Room state is held in the running server's memory. A restart or deploy ends active rooms, and the service should run as a single instance unless shared storage and a Socket.IO adapter are added.

## Verify

```sh
npm test
```