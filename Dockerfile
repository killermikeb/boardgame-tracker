# No npm install needed — server.js only uses Node's built-in modules.
# node:20-alpine is multi-arch, so this builds fine natively on Raspberry Pi
# (both 32-bit armv7 and 64-bit arm64 variants of Raspberry Pi OS).
FROM node:20-alpine

WORKDIR /app

COPY server.js ./
COPY public ./public

EXPOSE 3131

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3131/api/profiles || exit 1

CMD ["node", "server.js"]
