const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');

// Docker 환경에서는 시스템 ffmpeg 사용, 로컬에서는 ffmpeg-static 사용
const getFFmpegPath = () => {
    // Docker/Linux 환경 체크
    if (fs.existsSync('/usr/bin/ffmpeg')) {
        return '/usr/bin/ffmpeg';
    }
    // 로컬 개발 환경 (ffmpeg-static)
    return require('ffmpeg-static');
};
const ffmpegPath = getFFmpegPath();

class TranscribeService {
    constructor(apiKey) {
        this.openai = new OpenAI({ apiKey });
        this.tempDir = path.join(__dirname, '..', 'temp');

        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    async transcribe(videoUrl, language = 'ko') {
        const timestamp = Date.now();
        const videoPath = path.join(this.tempDir, `video_${timestamp}.mp4`);
        const audioPath = path.join(this.tempDir, `audio_${timestamp}.mp3`);

        try {
            console.log('[Transcribe] 비디오 다운로드 중...');
            await this.downloadFile(videoUrl, videoPath);

            console.log('[Transcribe] 오디오 추출 중...');
            await this.extractAudio(videoPath, audioPath);

            console.log('[Transcribe] Whisper API 호출 중...');
            const transcription = await this.callWhisperAPI(audioPath, language);

            return {
                success: true,
                text: transcription.text,
                language: language
            };

        } catch (error) {
            console.error('[Transcribe] 에러:', error.message);
            throw error;
        } finally {
            // 임시 파일 정리
            this.cleanupFile(videoPath);
            this.cleanupFile(audioPath);
        }
    }

    async downloadFile(url, filePath) {
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 120000
        });

        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    }

    async extractAudio(videoPath, audioPath) {
        return new Promise((resolve, reject) => {
            // ffmpeg를 사용해서 오디오 추출
            const ffmpeg = spawn(ffmpegPath, [
                '-i', videoPath,
                '-vn',
                '-acodec', 'libmp3lame',
                '-ab', '128k',
                '-ar', '16000',
                '-y',
                audioPath
            ]);

            ffmpeg.stderr.on('data', (data) => {
                // ffmpeg 진행 상황 (무시)
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`ffmpeg 실패: exit code ${code}`));
                }
            });

            ffmpeg.on('error', (err) => {
                reject(new Error(`ffmpeg 실행 실패: ${err.message}. ffmpeg가 설치되어 있는지 확인하세요.`));
            });
        });
    }

    async callWhisperAPI(audioPath, language) {
        const audioFile = fs.createReadStream(audioPath);

        const response = await this.openai.audio.transcriptions.create({
            file: audioFile,
            model: 'whisper-1',
            language: language,
            response_format: 'json'
        });

        return response;
    }

    cleanupFile(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (e) {
            console.log('[Transcribe] 파일 정리 실패:', e.message);
        }
    }
}

module.exports = TranscribeService;
