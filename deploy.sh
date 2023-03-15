#!/bin/bash
set -e

cdk deploy --outputs-file outputs.json --require-approval never

OUTPUTS=$(cat outputs.json | jq '.QuineAwsCdkStack')
CLUSTER=$(echo $OUTPUTS | jq -r '.ecsClusterName')
TASK_ARN=$(aws ecs list-tasks --cluster $CLUSTER --output json | jq -r '.taskArns[0]')

echo $OUTPUTS | jq '.'

aws ecs execute-command --cluster $CLUSTER \
    --task $TASK_ARN \
      --container quine \
     --interactive \
     --command "/bin/sh"
