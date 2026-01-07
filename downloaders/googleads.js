const puppeteer = require('puppeteer');

class GoogleAdsDownloader {
    constructor() {
        this.videoUrls = [];
    }

    async extractVideoUrl(url) {
        let browser = null;

        try {
            console.log(`[GoogleAds] URL 처리 시작: ${url}`);
            this.videoUrls = [];

            browser = await puppeteer.launch({
                headless: 'new',
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--disable-features=IsolateOrigins,site-per-process'
                ]
            });

            const page = await browser.newPage();

            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await page.setViewport({ width: 1920, height: 1080 });

            // 네트워크 요청 가로채기
            await page.setRequestInterception(true);

            page.on('request', (request) => {
                request.continue();
            });

            page.on('response', async (response) => {
                const reqUrl = response.url();

                // YouTube 관련 URL 찾기
                if (reqUrl.includes('youtube.com/watch') ||
                    reqUrl.includes('youtu.be/') ||
                    reqUrl.includes('youtube.com/embed/') ||
                    reqUrl.includes('googlevideo.com')) {
                    console.log(`[GoogleAds] YouTube URL 발견: ${reqUrl.substring(0, 80)}...`);
                    this.videoUrls.push(reqUrl);
                }
            });

            // 페이지 로드
            console.log('[GoogleAds] 페이지 로드 중...');
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

            // 추가 대기
            await page.waitForTimeout(3000);

            // HTML에서 YouTube URL 추출
            const htmlContent = await page.content();
            const youtubeUrls = this.extractYouTubeFromHtml(htmlContent);
            console.log(`[GoogleAds] HTML에서 YouTube URL ${youtubeUrls.length}개 발견`);

            // iframe 내용 확인
            const frames = page.frames();
            for (const frame of frames) {
                try {
                    const frameContent = await frame.content();
                    const frameUrls = this.extractYouTubeFromHtml(frameContent);
                    youtubeUrls.push(...frameUrls);
                } catch (e) {
                    // iframe 접근 실패 무시
                }
            }

            // 모든 URL 합치기
            const allUrls = [...this.videoUrls, ...youtubeUrls];
            const uniqueUrls = [...new Set(allUrls)];

            console.log(`[GoogleAds] 총 ${uniqueUrls.length}개 URL 수집`);

            // YouTube 비디오 ID 추출
            const videoIds = this.extractVideoIds(uniqueUrls);
            console.log(`[GoogleAds] 추출된 Video IDs: ${videoIds.join(', ')}`);

            await browser.close();

            if (videoIds.length > 0) {
                // 첫 번째 비디오 ID로 YouTube URL 반환
                const videoId = videoIds[0];
                return {
                    video_url: `https://www.youtube.com/watch?v=${videoId}`,
                    thumbnail_url: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                    title: 'Google Ads Video',
                    platform: 'googleads',
                    videoId: videoId,
                    isYouTube: true  // YouTube 다운로더로 처리 필요 표시
                };
            }

            console.log('[GoogleAds] YouTube 비디오를 찾을 수 없습니다');
            return null;

        } catch (error) {
            console.error(`[GoogleAds] 에러:`, error.message);
            if (browser) await browser.close();
            return null;
        }
    }

    extractYouTubeFromHtml(html) {
        const urls = [];
        const patterns = [
            /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/g,
            /https?:\/\/(?:www\.)?youtube\.com\/embed\/([A-Za-z0-9_-]{11})/g,
            /https?:\/\/youtu\.be\/([A-Za-z0-9_-]{11})/g,
            /https?:\/\/(?:www\.)?youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/g,
            /"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g,
            /video_id[=:]([A-Za-z0-9_-]{11})/g,
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(html)) !== null) {
                urls.push(match[0]);
            }
        }

        return urls;
    }

    extractVideoIds(urls) {
        const ids = new Set();
        const patterns = [
            /youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/,
            /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
            /youtu\.be\/([A-Za-z0-9_-]{11})/,
            /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
            /video_id[=:]([A-Za-z0-9_-]{11})/,
            /"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/,
        ];

        for (const url of urls) {
            for (const pattern of patterns) {
                const match = url.match(pattern);
                if (match) {
                    ids.add(match[1]);
                }
            }
        }

        // URL 자체가 11자리면 ID일 수 있음
        for (const url of urls) {
            const cleanUrl = url.replace(/[^A-Za-z0-9_-]/g, '');
            if (cleanUrl.length === 11) {
                ids.add(cleanUrl);
            }
        }

        return [...ids];
    }

    static isValidUrl(url) {
        return url.includes('adstransparency.google.com');
    }
}

module.exports = GoogleAdsDownloader;
