- docker pull ubuntu:latest
- docker run -it --name ubuntu1 ubuntu:latest bash
- apt update
- apt install -y curl ca-certificates
- curl -fsSL https://deb.nodesource.com/setup_24.x -o nodesource_setup.sh
  bash nodesource_setup.sh

- apt install nodejs -y

- docker cp /Users/jiten/workspace/training/LTM-Storage-Containers/node-docker-app ubuntu1:/app

# To build docker image

```bash
docker build . -t jpalaparthi/node-demo:v0.1
docker login
docker push jpalaparthi/node-demo:v0.1
```
