import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { aws_cassandra as cassandra } from 'aws-cdk-lib';
import * as fs from 'fs';


interface QuineAwsCdkStackProps extends cdk.StackProps {
  /**
   * If `true`, an Amazon Keyspaces keyspace will be created and Quine will be configured
   * to use it as data persistence. If `false`, a local RocksDB implementation within the
   * Quine container will be used. See https://docs.quine.io/components/persistors/persistor.html.
   *
   * @type {boolean}
   * @memberof QuineAwsCdkStackProps
   */
  useKeyspaces: boolean
  /**
   * Name of new keyspace to create in Amazon Keyspaces. 
   * 
   * Only applicable when `useKeyspaces` = `true`.
   * 
   * @type {string}
   * @memberof QuineAwsCdkStackProps
   */
  keyspaceName?: string
  /**
   * Password that was used to create a local cassandra_trustore.jks that we will inject
   * into our Quine container at runtime. This trustore includes a certificate that may
   * be needed to allow the AWS SigV4 Keyspaces driver to authenticate requests made
   * to Amazon Keyspaces using IAM role credentials of the parent container (e.g. an 
   * Amazon ECS, EKS, or EC2 environment).
   * 
   * Only applicable when `useKeyspaces` = `true`.
   *
   * @type {string}
   * @memberof QuineAwsCdkStackProps
   */
  truststorePassword?: string
  /**
   * If true, a public load balancer will be created to provide easy access to the Quine
   * container's web interface. 
   *
   * @type {boolean}
   * @memberof QuineAwsCdkStackProps
   */
  publicLoadBalancerEnabled: boolean
  /**
   * List of {@link ec2.iPeer} traffic sources, such as an IP address CIDR, that will be given
   * permission to access the Quine demo application's browser UI via a public port 80 TCP ingress
   * rule added to the security group of the Quine service's public load balancer. 
   * 
   * * Only applicable when `publicLoadBalancerEnabled: true`
   * * If no entries are provided, no public access ingress rules for the load balancer will be created. 
   *
   * @type {ec2.IPeer[]}
   * @memberof QuineAwsCdkStackProps
   */
  publicLoadBalancerIngressPeers?: ec2.IPeer[],
  /**
   *  When `true`, the ECS service for Quine will run Quine by setting the service's  desired task
   *  count to 1. When `false`, this construct will create all of the prerequisites (e.g. VPC, 
   *  Keyspace, ECS cluster, ECS task definition, etc.).
   *  
   *  When first deploying this product, it's recommend that you set this value to `false`. The reason
   *  for this is that if you instead set the value to true and the resulting Fargate container
   *  failed to launch (e.g. bug, or missing permissions) the CloudFormation stack created by CDK
   *  would initiate a rollback and you would have to wait for all of the resources created prior to 
   *  the failed task (e.g. VPC, load balancer, and keyspace) to be deleted before you could attempt 
   *  to deploy a fix. By first deploying with a value of `false`, we can safely get the prerequisites
   *  to run the container out of the way. Afterward, we can change the value to `true` and, if 
   *  deployment fails, have a much shorter rollback cycle.
   *  
   * * @type {boolean}
   * * @memberof QuineAwsCdkStackProps
   **/
  runQuineContainer: boolean
}

/**
 * Creates an ECS cluster and service that runs Quine as an ECS Fargate service inside
 * a new VPC, and configures Quine to use Amazon Keyspaces for data persistence. 
 * 
 * Quine is launched in a private subnet of our new VPC, and a public load balancer is
 * created to expose the Quine app's web interface to you for demo purposes. You can 
 * optionally disable the creation of the load balancer and/or scope the load balancer's 
 * security group ingress to a specific CIDR range. Even with a specific CIDR range,
 * the author recommends you do *not* provision the load balancer if you will be ingesting
 * any sensitive or otherwise confidential information with this demo implementation. 
 *
 * @export
 * @class QuineAwsCdkStack
 * @extends {cdk.Stack}
 */
export class QuineAwsCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: QuineAwsCdkStackProps) {
    super(scope, id, props);

    // Tag any taggable resource for tracking and reporting purposes: 
    cdk.Tags.of(this).add('project', 'quine-aws-cdk-demo');

    // These values should be passed at runtime when instantiating an instance of this class: 
    const AWS_REGION = props.env?.region || '';
    const AWS_ACCOUNT = props.env?.account || '';

    if (AWS_REGION === '') {
      throw new Error('env.region must be specified in stack properties.');
    }

    if (AWS_ACCOUNT === '') {
      throw new Error('env.account must be specified in stack properties.');
    }

    // For demo purposes, we use a single Availability zone, but a production use 
    // case should generally include at least two AZs for high availability. Similarly, 
    // best practices would typically call for bumping the number of NAT GWs to match
    // the number of AZ.
    const vpc = new ec2.Vpc(this, 'vpc', {
      maxAzs: props.publicLoadBalancerEnabled ? 2 : 1,    // An AWS load balancer requires a minimum of two AZs.                 
      natGateways: 1,     
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      enableFargateCapacityProviders: true,
    });

    // Four vCPUs (4096 CPU units) is the max supported by Fargate at this time. 
    // If more CPU is needed, you would need to instead launch Quine a larger EC2
    // instance. 8192 MiB is the lower limit of memory that Fargate allows for a 
    // four-vCPU Fargate container, and this can be increased to 30,720 MiB (30 GB). 
    // Similarly, EC2 would be needed for larger memory requirements. 
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 4096,              
      memoryLimitMiB: 8192,
    });

    // To connect to Amazon Keyspaces programmatically with a standard driver, a user must have 
    // SELECT access to the system tables, because most drivers read the system keyspaces/tables
    // on connection. Refer to link below for more detail:
    // https://docs.aws.amazon.com/keyspaces/latest/devguide/security_iam_service-with-iam.html
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "cassandra:Select"
        ],
        resources: [`arn:aws:cassandra:${AWS_REGION}:${AWS_ACCOUNT}:/keyspace/system*`],
      })
    );

    // Allows remote shell into our Fargate container service via Amazon ECS Instance Exec.
    // This is useful for test and debugging purposes. Refer to link below for more info:
    // https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec.html
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel"
        ],
        resources: ['*'],
      })
    );

    // When props.useKeyspaces = false, we will use the public default Quine image
    // published by the authors of Quine, thatDot. When useKeyspaces = true, we will
    // use a modified image from DockerHub that incorporates the Amazon SigV4 authentication
    // plugin that is needed to authenticate against Amazon Keyspaces using the IAM role
    // attached to our Fargate container. 
    let quineImage: ecs.ContainerImage;

    if (props.useKeyspaces === true) {

      if (!props.keyspaceName) {
        throw new Error('keyspaceName must be provided in stack props when useKeyspaces = true.');
      }

      if (!props.truststorePassword) {
        throw new Error('truststorePassword must be provided in stack props when useKeyspaces = true.');
      }
    
      // Create new keyspace in Amazon Keyspaces to act as data persistor. 
      const keyspace = new cassandra.CfnKeyspace(this, 'CassandraKeyspace', {
        keyspaceName: props.keyspaceName
      });

      // By default, AWS typically retains serverless data resources (e.g. S3 buckets, 
      // DynamoDB tables, Keyspaces tables) when the parent CloudFormation stack is 
      // deleted. However, for test purposes, we are instead ok with deleting the keyspace
      // when the stack is deleted. If no removal policy is explicitly applied, 
      // Amazon Keyspaces will retain the keyspace and is the equivalent to specifying
      // a value of `cdk.RemovalPolicy.RETAIN`.
      keyspace.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    
      // For this demo, the policy below is used to grant Quine full access to all available
      // Amazon Keyspaces APIs for our newly-created keyspace. In a real AWS environment, 
      // this should be scoped down to only those actions actually used by Quine. 
      taskDefinition.taskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "cassandra:*"
          ],
          resources: [`arn:aws:cassandra:${AWS_REGION}:${AWS_ACCOUNT}:/keyspace/${keyspace.ref}/table/*`],
        })
      );

    // In order for Quine to make authenticated API calls to Amazon Keyspaces using IAM credentials, 
    // the Quine executable must be compiled with the AWS SigV4 authentication plugin. This project
    // references an unofficial container image on DockerHub that already has this step completed
    // for you. Refer to the commits by user @matwerber1 in the fork of Quine below to see the changes made: 
    // https://github.com/matwerber1/quine
    // 
    // The SigV4 plugin also needs additional configuration to be functional. This configuration may be
    // provided at compile-time, but we use a more flexible approach of run-time configuration
    // below. Refer to the link below for more detail:
    // https://docs.aws.amazon.com/keyspaces/latest/devguide/using_java_driver.html#java_tutorial.SigV4
    const pluginTemplate = fs.readFileSync('./lib/resources/quine-conf-template.conf', 'utf-8');
    const pluginConfigBody = pluginTemplate
      .replace(/<<AWS_REGION>>/g, AWS_REGION)
      .replace(/<<KEYSTORE_PASSWORD>>/g, props.truststorePassword)
      .replace(/<<KEYSPACE_NAME>>/g, props.keyspaceName);
    fs.writeFileSync('./lib/images/quine/quine.conf', pluginConfigBody);

    // Build our configured Quine container locally and push the image to Amazon ECR:
    const dockerAsset = new ecrAssets.DockerImageAsset(this, 'QuineImage', {
      directory: './lib/images/quine',
      platform: ecrAssets.Platform.LINUX_AMD64,
    });
    quineImage = ecs.ContainerImage.fromDockerImageAsset(dockerAsset);
    new cdk.CfnOutput(this, 'quineKeyspaceName', {value: keyspace.ref});
    }
    else {
      quineImage = ecs.ContainerImage.fromRegistry('thatdot/quine');
    }

    // Test we will use to determine whether Quine was able to start successfully:
    const quineHealthCheck = `curl -s "http://127.0.0.1:8080/api/v1/admin/build-info"`;

    // ECS Task Definitions are templates of containers we can later run as part of
    // an ECS service or a one-off task. 
    taskDefinition.addContainer('quine', {
      image: quineImage,
      // Configure container to send stdout and stderr to Amazon CloudWatch Logs:
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'quine',
        mode: ecs.AwsLogDriverMode.NON_BLOCKING,    // Generally recommended to avoid potential application unavailability while waiting for log push
        logRetention: logs.RetentionDays.ONE_WEEK, 
      }),
      cpu: 4096, 
      memoryLimitMiB: 8192,
      // When using Amazon ECS Exec, certain actions may result in zombie processes
      // being left running in the background. Setting initProcessEnabled to true
      // will tell Fargate to clean up zombie processes. Refer to link below for detail:
      // https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec.html#ecs-exec-considerations
      linuxParameters: new ecs.LinuxParameters(this, "quineLinuxParams", {
        initProcessEnabled: true,
      }),
      startTimeout: cdk.Duration.seconds(10),
      stopTimeout: cdk.Duration.seconds(5),
      portMappings: [
        {
          containerPort: 8080,
          hostPort: 8080
        }
      ], 
      // Might have a mistake in the health check I made below, because health check was failing
      // even though the container logs said that Quine started successfully
      // healthCheck: {
      //   command: [
      //     "CMD-SHELL",
      //     `echo "ECS Health check: ${quineHealthCheck}" && ${quineHealthCheck} | jq '.' || exit 1`],
      //   interval: cdk.Duration.seconds(30),
      //   startPeriod: cdk.Duration.seconds(30),
      // }
    });

    const numberOfQuineTasksToRun = props.runQuineContainer ? 1 : 0;

    // Create an ECS Service to run the Quine container ECS Task Definition we defined above:
    const quineService = new ecs.FargateService(this, 'FargateService', {
      cluster,
      taskDefinition,
      propagateTags: ecs.PropagatedTagSource.TASK_DEFINITION,
      capacityProviderStrategies: [
        // Since we're only running one container, the higher weight on spot below
        // means our Quine container will run on lower-cost Fargate Spot capacity. 
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: 2,
        },
        {
          capacityProvider: 'FARGATE',
          weight: 1,
        },
      ],
      desiredCount: numberOfQuineTasksToRun,
      enableECSManagedTags: true,
      enableExecuteCommand: true,   // Allows for remote shell via Amazon ECS Exec
    });

    if (props.publicLoadBalancerEnabled) {
      // Which request sources, if any, are allowed to reach our private Quine container via
      // a public load balancer: 
      
      const publicLoadBalancerSecurityGroup = new ec2.SecurityGroup(this, 'QuineALBSecGroup', {
        vpc, 
      });

      props.publicLoadBalancerIngressPeers?.forEach(peer => {
        publicLoadBalancerSecurityGroup.addIngressRule(peer, ec2.Port.tcp(80));
      });

      const publicLoadBalancer = new elbv2.ApplicationLoadBalancer(this, 'QuineALB', { 
        vpc, 
        internetFacing: true,
        securityGroup: publicLoadBalancerSecurityGroup,
      });

      const publicLoadBalancerHttpListener = publicLoadBalancer.addListener('Listener', { 
        port: 80, 
        open: false
      });

      quineService.registerLoadBalancerTargets({
        containerName: 'quine',
        containerPort: 8080,
        newTargetGroupId: 'ecs-fargate-quine',
        listener: ecs.ListenerConfig.applicationListener(publicLoadBalancerHttpListener, {
          protocol: elbv2.ApplicationProtocol.HTTP
        }),
      });

      new cdk.CfnOutput(this, 'loadBalancerEndpoint', {value: publicLoadBalancer.loadBalancerDnsName});

    }

    new cdk.CfnOutput(this, 'ecsClusterName', {value: cluster.clusterName});
    new cdk.CfnOutput(this, 'ecsQuineServiceName', {value: quineService.serviceName});
    new cdk.CfnOutput(this, 'ecsQuineTaskDefinitionArn', {value: taskDefinition.taskDefinitionArn});
  }

}
