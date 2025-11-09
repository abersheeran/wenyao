# ============================================
# Stage 1: Frontend Build
# ============================================
FROM node:22-alpine AS frontend-build

WORKDIR /app/pages

# Copy frontend package files and install dependencies
COPY pages/package.json pages/package-lock.json ./
RUN npm ci

# Copy frontend source code and build
COPY pages/ ./
RUN npm run build

# ============================================
# Stage 2: Backend Build
# ============================================
FROM node:22-alpine AS backend-build

WORKDIR /app

# Copy backend package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy backend source code and build
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

# ============================================
# Stage 3: Production Runtime
# ============================================
FROM node:22-alpine AS production

WORKDIR /app

# Copy backend package files
COPY package.json package-lock.json ./

# Install only production dependencies for backend
RUN npm ci --omit=dev

# Copy backend build output
COPY --from=backend-build /app/dist ./dist

# Copy frontend build output (static files)
COPY --from=frontend-build /app/pages/build ./pages/build

# Expose the application port
EXPOSE 51818

# Environment variables (can be overridden at runtime)
ENV PORT=51818
ENV NODE_ENV=production

# Start the application
CMD ["node", "dist/index.js"]
