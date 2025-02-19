import { EC2Client, DescribeInstancesCommand, StopInstancesCommand, CreateTagsCommand } from '@aws-sdk/client-ec2';
import axios from 'axios';

const client = new EC2Client({ region: 'ap-northeast-2' });
const ALERT_TIME_LIMIT = 1; // 알림을 보낼 시간 제한 (시간 단위)
const BOT_TOKEN = '[TELEGRAM_BOT_TOKEN]';
const CHAT_ID = '[TELEGRAM_CHAT_ID]';

export const handler = async (event) => {
    try {
        const describeCommand = new DescribeInstancesCommand({});
        const instances = await client.send(describeCommand);
        const instancesToStop = [];
        const now = new Date();

        // 각 인스턴스 처리
        for (const reservation of instances.Reservations || []) {
            for (const instance of reservation.Instances || []) {
                if (instance.State.Name === 'running') {
                    // startedTime 태그 확인
                    let startedTimeTag = instance.Tags?.find(tag => tag.Key === 'startedTime');
                    
                    if (!startedTimeTag) {
                        // startedTime 태그가 없으면 현재 시간으로 생성
                        await client.send(new CreateTagsCommand({
                            Resources: [instance.InstanceId],
                            Tags: [{ Key: 'startedTime', Value: now.toISOString() }]
                        }));

                        // 새로운 인스턴스 시작 알림 전송
                        const tagsInfo = instance.Tags?.map(tag => `${tag.Key}: ${tag.Value}`).join('\n') || 'No tags';
                        const message = `New Instance Started: ${instance.InstanceId}\n\nTags:\n${tagsInfo}`;
                        await sendTelegramMessage(CHAT_ID, message, BOT_TOKEN);
                    } else {
                        // 실행 시간 체크 및 알림 전송
                        const startTime = new Date(startedTimeTag.Value);
                        const runningHours = (now - startTime) / (1000 * 60 * 60);
                        
                        if (runningHours > ALERT_TIME_LIMIT) {
                            const tagsInfo = instance.Tags?.map(tag => `${tag.Key}: ${tag.Value}`).join('\n') || 'No tags';
                            const message = `Warning: Instance ${instance.InstanceId} has been running for ${Math.floor(runningHours)} hours.\n\nTags:\n${tagsInfo}`;
                            await sendTelegramMessage(CHAT_ID, message, BOT_TOKEN);
                        }
                    }

                    // 기존 종료 시간 로직
                    const shutdownTag = instance.Tags?.find(tag => tag.Key === 'shutdownTime');
                    if (shutdownTag) {
                        const tagTime = new Date(shutdownTag.Value);
                        if (tagTime <= now) {
                            instancesToStop.push(instance.InstanceId);
                        }
                    }
                }
            }
        }

        // 종료할 인스턴스가 있을 경우 중지
        if (instancesToStop.length > 0) {
            console.log(`Stopping instances: ${instancesToStop.join(', ')}`);
            const stopCommand = new StopInstancesCommand({ 
                InstanceIds: instancesToStop 
            });
            await client.send(stopCommand);
            console.log('Instances stopped successfully.');
        } else {
            console.log('No instances to stop at this time.');
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: `Processed ${instancesToStop.length} instances`,
                stoppedInstances: instancesToStop
            })
        };
    } catch (error) {
        console.error('Error processing instances:', error);
        throw error;
    }
};

async function sendTelegramMessage(chatId, message, botToken) {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const payload = {
        chat_id: chatId,
        text: message,
    };
    const response = await axios.post(url, payload);
    return response.data;
}