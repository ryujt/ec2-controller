import { EC2Client, DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand, CreateTagsCommand, DeleteTagsCommand } from "@aws-sdk/client-ec2";
import { Route53Client, ChangeResourceRecordSetsCommand } from "@aws-sdk/client-route-53";

const ec2Client = new EC2Client();
const route53Client = new Route53Client();

async function waitForPublicIp(instanceId) {
    let attempts = 0;
    const maxAttempts = 30;
    
    while (attempts < maxAttempts) {
        const { Reservations } = await ec2Client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
        const instance = Reservations[0].Instances[0];
        if (instance.PublicIpAddress) {
            return instance.PublicIpAddress;
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
        attempts++;
    }
    throw new Error('IP 할당 시간 초과');
}

async function updateDNS(domain, hostedZoneId, publicIp) {
    if (!domain || !hostedZoneId || !publicIp) {
        console.log('DNS 업데이트를 위한 필수 파라미터가 누락되어 업데이트를 건너뜁니다:', { domain, hostedZoneId, publicIp });
        return;
    }
    
    const params = {
        ChangeBatch: {
            Changes: [
                {
                    Action: "UPSERT",
                    ResourceRecordSet: {
                        Name: domain,
                        Type: "A",
                        TTL: 300,
                        ResourceRecords: [{ Value: publicIp }]
                    }
                }
            ]
        },
        HostedZoneId: hostedZoneId
    };
    await route53Client.send(new ChangeResourceRecordSetsCommand(params));
}

async function addShutdownTag(instanceId, shutdownTime) {
    await ec2Client.send(new CreateTagsCommand({
        Resources: [instanceId],
        Tags: [{ Key: 'shutdownTime', Value: shutdownTime.toISOString() }]
    }));
}

async function removeShutdownTag(instanceId) {
    await ec2Client.send(new DeleteTagsCommand({
        Resources: [instanceId],
        Tags: [{ Key: 'shutdownTime' }]
    }));
}

export const handler = async (event) => {
    try {
        const action = event.queryStringParameters?.action;
        const instanceId = event.queryStringParameters?.instanceId;
        const domain = event.queryStringParameters?.domain;
        const hostedZoneId = event.queryStringParameters?.hostedZoneId;
        
        if (action === 'list') {
            const { Reservations } = await ec2Client.send(new DescribeInstancesCommand({}));
            const instances = Reservations.flatMap(reservation => reservation.Instances.map(instance => ({
                instanceId: instance.InstanceId,
                state: instance.State.Name,
                publicIp: instance.PublicIpAddress
            })));
            return response(200, { instances });
        }
        
        if (!instanceId) {
            return response(400, { error: '인스턴스 ID가 필요합니다.' });
        }
        
        if (action === 'start') {
            await ec2Client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
            await removeShutdownTag(instanceId);
            
            if (!domain || !hostedZoneId) {
                return response(200, { message: '인스턴스를 시작했습니다. Domain 또는 HostedZoneId가 제공되지 않아 DNS 업데이트는 건너뛰었습니다.' });
            }
            
            try {
                const publicIp = await waitForPublicIp(instanceId);
                await updateDNS(domain, hostedZoneId, publicIp);
                return response(200, { message: '인스턴스를 시작하고 DNS를 업데이트했습니다.', publicIp });
            } catch (error) {
                return response(200, { message: '인스턴스를 시작했지만 DNS 업데이트에 실패했습니다.', error: error.message });
            }
        }
        
        if (action === 'start1h') {
            const { Reservations } = await ec2Client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
            const instance = Reservations[0].Instances[0];
            const isRunning = instance.State.Name === 'running';
            
            if (!isRunning) {
                await ec2Client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
            }
            
            const shutdownTime = new Date();
            shutdownTime.setHours(shutdownTime.getHours() + 1);
            await addShutdownTag(instanceId, shutdownTime);
            
            if (!domain || !hostedZoneId) {
                return response(200, { 
                    message: `인스턴스가 ${isRunning ? '이미 실행 중입니다.' : '시작되었습니다.'} ${shutdownTime.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}에 자동 종료됩니다. Domain 또는 HostedZoneId가 제공되지 않아 DNS 업데이트는 건너뛰었습니다.`
                });
            }
            
            try {
                let publicIp;
                if (!isRunning) {
                    publicIp = await waitForPublicIp(instanceId);
                    await updateDNS(domain, hostedZoneId, publicIp);
                } else {
                    publicIp = instance.PublicIpAddress;
                    await updateDNS(domain, hostedZoneId, publicIp);
                }
                return response(200, { 
                    message: `인스턴스가 ${isRunning ? '이미 실행 중입니다.' : '시작되었습니다.'} ${shutdownTime.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}에 자동 종료됩니다.`,
                    publicIp 
                });
            } catch (error) {
                return response(200, { message: '작업 중 오류가 발생했습니다.', error: error.message });
            }
        }
        
        if (action === 'stop') {
            await ec2Client.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
            return response(200, { message: '인스턴스를 중지했습니다.' });
        }
        
        const { Reservations } = await ec2Client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
        const instance = Reservations[0].Instances[0];
        return response(200, { instanceId: instance.InstanceId, state: instance.State.Name, publicIp: instance.PublicIpAddress });
    } catch (error) {
        console.error('Error:', error);
        return response(500, { error: '서버 에러가 발생했습니다.' });
    }
};

const response = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
