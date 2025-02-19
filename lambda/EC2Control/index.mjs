import { EC2Client, DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand, CreateTagsCommand, DeleteTagsCommand } from "@aws-sdk/client-ec2";
import { Route53Client, ChangeResourceRecordSetsCommand } from "@aws-sdk/client-route-53";

const ec2Client = new EC2Client();
const route53Client = new Route53Client();

async function waitForPublicIp(instanceId) {
    let attempts = 0;
    const maxAttempts = 30; // 최대 30회 시도 (약 2.5분)
    
    while (attempts < maxAttempts) {
        const { Reservations } = await ec2Client.send(new DescribeInstancesCommand({
            InstanceIds: [instanceId]
        }));
        
        const instance = Reservations[0].Instances[0];
        if (instance.PublicIpAddress) {
            return instance.PublicIpAddress;
        }
        
        await new Promise(resolve => setTimeout(resolve, 5000)); // 5초 대기
        attempts++;
    }
    throw new Error('IP 할당 시간 초과');
}

async function updateDNS(domain, hostedZoneId, publicIp) {
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
        Tags: [{
            Key: 'shutdownTime',
            Value: shutdownTime.toISOString()
        }]
    }));
}

async function removeShutdownTag(instanceId) {
    await ec2Client.send(new DeleteTagsCommand({
        Resources: [instanceId],
        Tags: [{
            Key: 'shutdownTime'
        }]
    }));
}

export const handler = async (event) => {
    try {
        const instanceId = event.queryStringParameters?.instanceId;
        const domain = event.queryStringParameters?.domain;
        const hostedZoneId = event.queryStringParameters?.hostedZoneId;

        if (!instanceId) {
            return response(400, { error: '인스턴스 ID가 필요합니다.' });
        }
        const action = event.queryStringParameters?.action;
        
        if (action === 'start') {
            if (!domain || !hostedZoneId) {
                return response(400, { error: 'Domain과 HostedZoneId가 필요합니다.' });
            }

            await ec2Client.send(new StartInstancesCommand({
                InstanceIds: [instanceId]
            }));
            
            // 시작할 때 shutdownTime 태그 제거
            await removeShutdownTag(instanceId);
            
            try {
                const publicIp = await waitForPublicIp(instanceId);
                await updateDNS(domain, hostedZoneId, publicIp);
                return response(200, { 
                    message: '인스턴스를 시작하고 DNS를 업데이트했습니다.',
                    publicIp 
                });
            } catch (error) {
                return response(200, { 
                    message: '인스턴스를 시작했지만 DNS 업데이트에 실패했습니다.',
                    error: error.message 
                });
            }
        }
        
        if (action === 'start1h') {
            if (!domain || !hostedZoneId) {
                return response(400, { error: 'Domain과 HostedZoneId가 필요합니다.' });
            }

            // 현재 인스턴스 상태 확인
            const { Reservations } = await ec2Client.send(new DescribeInstancesCommand({
                InstanceIds: [instanceId]
            }));
            const instance = Reservations[0].Instances[0];
            const isRunning = instance.State.Name === 'running';

            // 인스턴스가 실행 중이 아닐 경우에만 시작
            if (!isRunning) {
                await ec2Client.send(new StartInstancesCommand({
                    InstanceIds: [instanceId]
                }));
            }

            // UTC 시간으로 1시간 후 설정
            const shutdownTime = new Date();
            shutdownTime.setHours(shutdownTime.getHours() + 1);
            await addShutdownTag(instanceId, shutdownTime);

            try {
                let publicIp;
                if (!isRunning) {
                    publicIp = await waitForPublicIp(instanceId);
                    await updateDNS(domain, hostedZoneId, publicIp);
                } else {
                    publicIp = instance.PublicIpAddress;
                }

                return response(200, { 
                    message: `인스턴스가 ${isRunning ? '이미 실행 중입니다.' : '시작되었습니다.'} ${shutdownTime.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}에 자동 종료됩니다.`,
                    publicIp 
                });
            } catch (error) {
                return response(200, { 
                    message: '작업 중 오류가 발생했습니다.',
                    error: error.message 
                });
            }
        }
        
        if (action === 'stop') {
            await ec2Client.send(new StopInstancesCommand({
                InstanceIds: [instanceId]
            }));
            return response(200, { message: '인스턴스를 중지했습니다.' });
        }
        
        // 인스턴스 상태 조회
        const { Reservations } = await ec2Client.send(new DescribeInstancesCommand({
            InstanceIds: [instanceId]
        }));
        
        const instance = Reservations[0].Instances[0];
        return response(200, {
            instanceId: instance.InstanceId,
            state: instance.State.Name,
            publicIp: instance.PublicIpAddress
        });
        
    } catch (error) {
        console.error('Error:', error);
        return response(500, { error: '서버 에러가 발생했습니다.' });
    }
};

const response = (statusCode, body) => ({
    statusCode,
    body: JSON.stringify(body)
});
