FROM berbs/quine-aws-sigv4-test:latest

RUN apt update -y && apt install -y \
    jq

COPY cassandra_truststore.jks .
COPY quine.conf .

# The "UNKNOWN" part of the JAR below is because I'm using a forked version of the 
# OSS Quine project that included the AWS Sigv4 auth plugin for test purposes and
# when I baked the image with sbt, I didn't set a value for that version property. 

ENTRYPOINT [ \
    "java", \
    "-XX:+AlwaysPreTouch", \
    "-XX:+UseParallelGC", \
    "-XX:InitialRAMPercentage=40.0", \
    "-XX:MaxRAMPercentage=80.0", \
    "-Dconfig.file=quine.conf",  \
    "-Djavax.net.ssl.trustStore=/cassandra_truststore.jks", \
    "-Djavax.net.ssl.trustStorePassword=123456", \
    "-jar", \
    "/quine-assembly-UNKNOWN.jar" \
    ]