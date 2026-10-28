# Node.js + Docker — Complete Example

A simple Express REST API with a production-dependency Docker build, health check, and Docker Compose configuration.

## Requirements
- Docker Engine with Docker Compose plugin (or Docker Desktop)
- Node.js 24 and npm (only for local execution or regenerating the lockfile)

## Quick start (Docker Compose)
```bash
docker compose up -d --build
docker compose ps
curl http://localhost:3000/
curl http://localhost:3000/health
curl http://localhost:3000/users
```

Stop and remove the Compose-managed container:
```bash
docker compose down
```

## Docker without Compose
```bash
docker build -t node-docker-app:1.0 .
docker run -d --name node-app -p 3000:3000 node-docker-app:1.0
docker ps
docker logs node-app
docker exec -it node-app sh
docker stop node-app
docker rm node-app
```

Do not run the Compose and standalone Docker variants simultaneously: both use the name `node-app` and host port 3000.

## Run without Docker
```bash
npm install
npm start
```
Then open http://localhost:3000.

## API endpoints
- `GET /` — application welcome and status
- `GET /health` — status and current UTC timestamp
- `GET /users` — sample users

## Docker Hub deployment
```bash
docker login
docker tag node-docker-app:1.0 YOUR_DOCKER_USERNAME/node-docker-app:1.0
docker push YOUR_DOCKER_USERNAME/node-docker-app:1.0
```
On a different server:
```bash
docker pull YOUR_DOCKER_USERNAME/node-docker-app:1.0
docker run -d --name node-app --restart unless-stopped -p 3000:3000 YOUR_DOCKER_USERNAME/node-docker-app:1.0
```
For internet-facing production use, add HTTPS, a reverse proxy, and appropriate firewall rules.

## Health check
```bash
docker inspect --format='{{.State.Health.Status}}' node-app
```
Wait for the first health check to finish.

## Scale with Compose
Remove `container_name` and the `ports` section from `compose.yaml`, then add `expose: ["3000"]` to the service and run:
```bash
docker compose up -d --build --scale node-app=3
```
A reverse proxy/load balancer is required to expose these replicas through one public endpoint.
