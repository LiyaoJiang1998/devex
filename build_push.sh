#!/bin/bash
# build tag and push the local image
# pass the tag name as first arg
docker build -t cityofedmonton/devex_mean:$1 -t cityofedmonton/devex_mean:latest .
docker push cityofedmonton/devex_mean:$1
docker push cityofedmonton/devex_mean:latest