#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { QuineAwsCdkStack } from '../lib/quine-aws-cdk-stack';
import { exec, ExecException } from "child_process";
import { promisify } from "util";
import * as ec2 from "aws-cdk-lib/aws-ec2";
const execPromise = promisify(exec);

async function main() {
  const app = new cdk.App();

  new QuineAwsCdkStack(app, 'QuineAwsCdkStack', {
    // We need the region at stack synth (before deployment) so we can embed it within
    // a config file we bake into our Docker image that's needed to tell the datastax
    // driver how to connect to Amazon Keyspaces. See link below for detail: 
    // https://stackoverflow.com/questions/64507069/how-to-configure-aws-cdk-account-and-region-to-look-up-a-vpc

    env: { 
        // The CDK_DEFAULT_* env vars will use whatever account and region your current AWS CLI credentials are using.
        // This could lead to accidental deployment to wrong account, so you should REPLACE these values with static
        // values if you work with multiple accounts or regions.
        account: process.env.CDK_DEFAULT_ACCOUNT, 
        region: process.env.CDK_DEFAULT_REGION,
    },
    
    useKeyspaces: false,          // If false, Quine will instead use a local RocksDB database rather than Amazon Keyspaces
    
    // Name of keyspace to create in Amazon Keyspaces; only needed if useKeyspaces = true
    //keyspaceName: 'quine_demo',   

    // AWS SigV4 Cassandra plugin requires truststore with particular cert for backwards compatibility.
    // In this demo, truststore file baked into Docker image was created with the password below. 
    // For security, you should recreate the keystore with a strong password and dynamically load the value
    // from environment variables at runtime rather than hard code like below. 
    // https://docs.aws.amazon.com/keyspaces/latest/devguide/using_java_driver.html#using_java_driver.BeforeYouBegin 
    // Only needed when useKeyspaces = true
    //truststorePassword: '123456',

    runQuineContainer: true,         // If false, ECS service and dependencies will be created, but desiredCount will be set to zero:
    publicLoadBalancerEnabled: true,
    publicLoadBalancerIngressPeers: [
      // await getMyPublicIpAddress(),        Attempt to retrieve your public IP address (doesn't work in all cases)
      // ec2.Peer.ipv4('1.2.3.4/32')   Example of explicitly providing an IP address or CIDR block that can access Quine via your load balancer
      ec2.Peer.ipv4('52.95.4.3/32')
    ]
  });

}

/**
 * Runs `dig +short myip.opendns.com @resolver1.opendns.com` to determine your current public
 * IP address. If this results in an error, it's possible a local firewall or VPN service
 * is preventing the necessary query from being completed.
 *
 * @return {*}  {Promise<ec2.IPeer>}
 */
async function getMyPublicIpAddress(): Promise<ec2.IPeer> {
  try {
    const execResponse = await execPromise('dig +short myip.opendns.com @resolver1.opendns.com');
    return ec2.Peer.ipv4(`${execResponse.stdout}/32`);
  }
  catch (err) {
    throw new Error(`Failed while trying to determine your public IP address. Try visiting https://whatismyipaddress.com/ and update ./bin/quine-aws-cdk.ts accordingly.\n${err}\n`);
  }
}

(async () => {
  await main();
})();