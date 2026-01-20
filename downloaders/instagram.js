const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const supabase = require('../services/supabase');

// Puppeteer lazy load
let puppeteer = null;
const getPuppeteer = () => {
    if (!puppeteer) {
        try {
            puppeteer = require('puppeteer');
        } catch (e) {
            console.log('[Instagram] Puppeteer 없음');
            return null;
        }
    }
    return puppeteer;
};

class InstagramDownloader {
    constructor() {
        this.cookiesPath = path.join(__dirname, '..', 'instagram_cookies.json');
    }

    extractShortcode(url) {
        const match = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
        return match ? match[1] : null;
    }

    extractUrlType(url) {
        const match = url.match(/instagram\.com\/(p|reel|reels|tv)\//);
        return match ? match[1] : 'p';
    }

    async loadSessionId() {
        // 1. Supabase에서 먼저 확인
        if (supabase.enabled) {
            const session = await supabase.getSession('instagram_sessionid');
            if (session) {
                console.log('[Instagram] Supabase에서 sessionid 로드');
                try {
                    return decodeURIComponent(session);
                } catch {
                    return session;
                }
            }
        }

        // 2. 로컬 파일에서 확인
        try {
            if (fs.existsSync(this.cookiesPath)) {
                const data = JSON.parse(fs.readFileSync(this.cookiesPath, 'utf8'));
                const session = data.find(c => c.name === 'sessionid');
                if (session?.value) {
                    try {
                        return decodeURIComponent(session.value);
                    } catch {
                        return session.value;
                    }
                }
            }
        } catch (e) {
            console.log('[Instagram] 쿠키 로드 실패:', e.message);
        }
        return null;
    }

    async extractVideoUrl(url) {
        console.log(`[Instagram] URL 처리 시작: ${url}`);

        const shortcode = this.extractShortcode(url);
        if (!shortcode) {
            console.log('[Instagram] shortcode 추출 실패');
            return null;
        }
        console.log(`[Instagram] Shortcode: ${shortcode}`);

        const sessionid = await this.loadSessionId();
        if (!sessionid) {
            console.log('[Instagram] sessionid 없음 - 쿠키를 먼저 저장해주세요');
            return null;
        }
        console.log('[Instagram] sessionid 로드 완료');

        // ds_user_id 추출 (sessionid의 첫 번째 부분)
        const dsUserId = sessionid.split(':')[0];

        // URL 타입에 맞는 Referer 설정
        const urlType = this.extractUrlType(url);
        console.log(`[Instagram] URL 타입: ${urlType}`);

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
            'Cookie': `sessionid=${sessionid}; ds_user_id=${dsUserId}`,
            'X-IG-App-ID': '936619743392459',
            'X-ASBD-ID': '129477',
            'X-Requested-With': 'XMLHttpRequest',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'Referer': `https://www.instagram.com/${urlType}/${shortcode}/`,
        };

        // GraphQL API 시도
        try {
            const result = await this.tryGraphQL(shortcode, headers);
            if (result) {
                // 광고 콘텐츠면 yt-dlp로 미리 다운로드
                if (result.isAd) {
                    console.log('[Instagram] 광고 콘텐츠 - yt-dlp로 미리 다운로드...');
                    const localVideo = await this.downloadAdVideo(url, shortcode);
                    if (localVideo) {
                        return {
                            ...result,
                            video_url: localVideo.serverUrl,
                            local_path: localVideo.filePath,
                            isLocalVideo: true
                        };
                    }
                    // yt-dlp 실패해도 원본 결과 반환 (전사 시 다시 시도)
                    console.log('[Instagram] yt-dlp 실패, 원본 URL 반환');
                }
                return result;
            }
        } catch (e) {
            console.log('[Instagram] GraphQL 실패:', e.message);
        }

        // embed API 시도
        try {
            const embedResult = await this.tryEmbedApi(shortcode, headers);
            if (embedResult) return embedResult;
        } catch (e) {
            console.log('[Instagram] embed API 실패:', e.message);
        }

        // 기존 API 시도
        const apiUrls = [
            `https://www.instagram.com/reel/${shortcode}/?__a=1&__d=dis`,
            `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`,
        ];

        for (const apiEndpoint of apiUrls) {
            try {
                console.log(`[Instagram] API 요청: ${apiEndpoint.substring(0, 60)}...`);

                const response = await axios.get(apiEndpoint, {
                    headers,
                    timeout: 15000,
                });

                const data = response.data;
                const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);

                console.log(`[Instagram] 응답 길이: ${jsonStr.length}`);

                const videoUrl = this.extractVideoFromResponse(jsonStr);

                if (videoUrl) {
                    console.log('[Instagram] 비디오 URL 발견!');
                    return {
                        video_url: videoUrl,
                        thumbnail_url: this.extractThumbnail(jsonStr),
                        title: this.extractTitle(jsonStr),
                        platform: 'instagram'
                    };
                }
            } catch (error) {
                console.log(`[Instagram] API 실패: ${error.response?.status || error.message}`);
            }
        }

        console.log('[Instagram] 모든 API 실패');
        return null;
    }

    async tryEmbedApi(shortcode, headers) {
        try {
            // Instagram embed API - 공개 접근 가능한 URL 반환
            const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/`;
            console.log('[Instagram] embed API 요청...');

            const response = await axios.get(embedUrl, {
                headers: {
                    ...headers,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
                timeout: 15000,
            });

            const html = response.data;

            // embed HTML에서 비디오 URL 추출
            const videoMatch = html.match(/"video_url"\s*:\s*"([^"]+)"/);
            if (videoMatch) {
                const videoUrl = this.cleanUrl(videoMatch[1]);
                console.log('[Instagram] embed에서 비디오 URL 발견:');
                console.log(videoUrl);

                return {
                    video_url: videoUrl,
                    thumbnail_url: this.extractThumbnail(html),
                    title: this.extractTitle(html),
                    platform: 'instagram',
                    isAd: false
                };
            }

            // 다른 형식 시도
            const srcMatch = html.match(/video[^>]*src="([^"]+\.mp4[^"]*)"/i);
            if (srcMatch) {
                const videoUrl = this.cleanUrl(srcMatch[1]);
                console.log('[Instagram] embed video src에서 URL 발견:');
                console.log(videoUrl);

                return {
                    video_url: videoUrl,
                    thumbnail_url: null,
                    title: 'Instagram Video',
                    platform: 'instagram',
                    isAd: false
                };
            }

        } catch (error) {
            console.log('[Instagram] embed API 실패:', error.response?.status || error.message);
        }

        return null;
    }

    async tryGraphQL(shortcode, headers) {
        // Instagram GraphQL doc_id for media info
        const docIds = [
            '8845758582119845',  // reel/post info
            '7153581528070080',  // alternative
        ];

        for (const docId of docIds) {
            try {
                const variables = JSON.stringify({ shortcode: shortcode });
                const url = `https://www.instagram.com/graphql/query/?doc_id=${docId}&variables=${encodeURIComponent(variables)}`;

                console.log(`[Instagram] GraphQL 요청 (doc_id: ${docId})...`);

                const response = await axios.get(url, {
                    headers,
                    timeout: 15000,
                });

                const jsonStr = JSON.stringify(response.data);
                console.log(`[Instagram] GraphQL 응답 길이: ${jsonStr.length}`);

                // 디버그: 응답 구조 확인
                const isAd = jsonStr.includes('product_type.ad');
                if (isAd) {
                    console.log('[Instagram] ========== 광고 콘텐츠 GraphQL 응답 분석 ==========');
                    // video 관련 키워드 모두 찾기
                    const videoKeys = jsonStr.match(/"(video[^"]*|dash[^"]*|playback[^"]*|media[^"]*url)"\s*:/gi);
                    if (videoKeys) {
                        console.log('[Instagram] 비디오 관련 키:', [...new Set(videoKeys)].join(', '));
                    }
                    // URL 패턴 찾기
                    const urls = jsonStr.match(/https?:[^"]+\.(mp4|m3u8|mpd)[^"]*/gi);
                    if (urls) {
                        console.log('[Instagram] 발견된 미디어 URL들:');
                        [...new Set(urls)].forEach((u, i) => {
                            const cleanUrl = u.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
                            console.log(`[Instagram]   ${i + 1}. ${cleanUrl.substring(0, 150)}...`);
                        });
                    }
                    // dash_info 확인
                    if (jsonStr.includes('dash_info') || jsonStr.includes('dash_manifest')) {
                        console.log('[Instagram] DASH 스트림 정보 발견!');
                    }
                    console.log('[Instagram] ================================================');
                }

                const videoUrl = this.extractVideoFromResponse(jsonStr);

                if (videoUrl) {
                    console.log('[Instagram] GraphQL에서 비디오 URL 발견!');

                    // 광고 여부 확인
                    const isAd = jsonStr.includes('product_type.ad') || jsonStr.includes('"is_paid_partnership"');
                    if (isAd) {
                        console.log('[Instagram] 광고 콘텐츠 감지됨');
                    }

                    return {
                        video_url: videoUrl,
                        thumbnail_url: this.extractThumbnail(jsonStr),
                        title: this.extractTitle(jsonStr),
                        platform: 'instagram',
                        isAd: isAd
                    };
                }
            } catch (error) {
                console.log(`[Instagram] GraphQL 실패 (${docId}): ${error.response?.status || error.message}`);
            }
        }

        return null;
    }

    extractVideoFromResponse(jsonStr) {
        // 모든 video URL 후보 수집
        const candidates = [];

        // video_url 직접
        const videoUrlMatches = jsonStr.matchAll(/"video_url"\s*:\s*"([^"]+)"/g);
        for (const match of videoUrlMatches) {
            candidates.push({ type: 'video_url', url: this.cleanUrl(match[1]) });
        }

        // video_versions 배열
        const versionsMatches = jsonStr.matchAll(/"video_versions"\s*:\s*\[([^\]]+)\]/g);
        for (const match of versionsMatches) {
            const urlMatch = match[1].match(/"url"\s*:\s*"([^"]+)"/);
            if (urlMatch) {
                candidates.push({ type: 'video_versions', url: this.cleanUrl(urlMatch[1]) });
            }
        }

        // 후보 URL 전체 출력 (테스트용)
        if (candidates.length > 0) {
            console.log(`[Instagram] ========== 비디오 URL 후보 ${candidates.length}개 ==========`);
            candidates.forEach((c, i) => {
                console.log(`[Instagram] ${i + 1}. ${c.type}:`);
                console.log(c.url);
                console.log('');
            });
            console.log(`[Instagram] ================================================`);
        }

        // /v/ 형식 우선 (구형 CDN - 보통 더 접근성 좋음)
        const oldCdnCandidate = candidates.find(c => c.url.includes('/v/') && !c.url.includes('/o1/v/'));
        if (oldCdnCandidate) {
            console.log('[Instagram] 구형 CDN URL 선택');
            return oldCdnCandidate.url;
        }

        // 첫 번째 후보 반환
        if (candidates.length > 0) {
            return candidates[0].url;
        }

        // CDN URL 직접
        const cdnMatch = jsonStr.match(/(https?:\\\/\\\/[^"]*?cdninstagram\.com\\\/[^"]*?\.mp4[^"]*)/);
        if (cdnMatch) {
            return this.cleanUrl(cdnMatch[1]);
        }

        // o1/v/ 형식 CDN URL
        const cdnMatch2 = jsonStr.match(/(https?:\\\/\\\/[^"]*?cdninstagram\.com\\\/o1\\\/v\\\/[^"]+)/);
        if (cdnMatch2) {
            return this.cleanUrl(cdnMatch2[1]);
        }

        return null;
    }

    extractThumbnail(jsonStr) {
        const match = jsonStr.match(/"display_url"\s*:\s*"([^"]+)"/);
        if (match) return this.cleanUrl(match[1]);

        const match2 = jsonStr.match(/"thumbnail_url"\s*:\s*"([^"]+)"/);
        if (match2) return this.cleanUrl(match2[1]);

        const match3 = jsonStr.match(/"image_versions2"[^}]*"url"\s*:\s*"([^"]+)"/);
        if (match3) return this.cleanUrl(match3[1]);

        return null;
    }

    extractTitle(jsonStr) {
        const captionMatch = jsonStr.match(/"text"\s*:\s*"([^"]{1,100})"/);
        if (captionMatch) {
            return captionMatch[1].substring(0, 100);
        }
        return 'Instagram Reels Video';
    }

    cleanUrl(url) {
        if (!url) return '';
        return url
            .replace(/\\u0026/g, '&')
            .replace(/\\\//g, '/')
            .replace(/\\u0025/g, '%')
            .replace(/&amp;/g, '&')
            .replace(/\\"/g, '"')
            .trim();
    }

    static isValidUrl(url) {
        return /instagram\.com\/(reel|reels|p|tv)\//.test(url);
    }

    // 광고 비디오 미리 다운로드 (추출 단계에서)
    async downloadAdVideo(url, shortcode) {
        const tempDir = path.join(__dirname, '..', 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const filename = `ad_${shortcode}_${Date.now()}.mp4`;
        const filePath = path.join(tempDir, filename);

        console.log('[Instagram] 광고 비디오 다운로드 중...');

        // yt-dlp로 다운로드
        const result = await this.downloadWithYtdlp(url, filePath);
        if (result && fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            if (stats.size > 1000) {
                console.log(`[Instagram] 광고 비디오 저장 완료: ${filename} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
                return {
                    filePath: filePath,
                    serverUrl: `/temp/${filename}`
                };
            }
        }

        return null;
    }

    // Puppeteer로 비디오 직접 다운로드 (광고 콘텐츠용)
    async downloadWithPuppeteer(url, outputPath) {
        const pup = getPuppeteer();
        if (!pup) {
            console.log('[Instagram] Puppeteer 사용 불가');
            return null;
        }

        console.log('[Instagram] Puppeteer로 비디오 다운로드 시도...');
        let browser = null;

        try {
            const sessionid = await this.loadSessionId();
            if (!sessionid) {
                console.log('[Instagram] sessionid 없음');
                return null;
            }

            const dsUserId = sessionid.split(':')[0];

            browser = await pup.launch({
                headless: 'new',
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });

            const page = await browser.newPage();

            // 쿠키 설정
            await page.setCookie({
                name: 'sessionid',
                value: sessionid,
                domain: '.instagram.com',
                path: '/',
                httpOnly: true,
                secure: true
            }, {
                name: 'ds_user_id',
                value: dsUserId,
                domain: '.instagram.com',
                path: '/',
            });

            // 페이지 접속
            console.log('[Instagram] Puppeteer 페이지 로딩...');
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

            // 비디오 요소에서 src 추출
            const videoUrl = await page.evaluate(() => {
                const video = document.querySelector('video');
                if (video) {
                    return video.src || video.querySelector('source')?.src;
                }
                return null;
            });

            if (videoUrl) {
                console.log('[Instagram] Puppeteer에서 비디오 URL 발견:');
                console.log(videoUrl);

                // 비디오 다운로드
                const response = await page.goto(videoUrl);
                const buffer = await response.buffer();
                fs.writeFileSync(outputPath, buffer);

                console.log(`[Instagram] Puppeteer 다운로드 완료: ${buffer.length} bytes`);
                await browser.close();
                return outputPath;
            }

            // video src가 없으면 네트워크 요청에서 찾기
            console.log('[Instagram] video src 없음, 페이지 재로드하며 네트워크 감시...');

            let capturedVideoUrl = null;
            await page.setRequestInterception(true);

            page.on('request', (request) => {
                const reqUrl = request.url();
                if (reqUrl.includes('.mp4') || reqUrl.includes('cdninstagram.com/o1/v/')) {
                    capturedVideoUrl = reqUrl;
                    console.log('[Instagram] 네트워크에서 비디오 URL 캡처:');
                    console.log(reqUrl);
                }
                request.continue();
            });

            await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });

            // 비디오 재생 시도
            await page.evaluate(() => {
                const video = document.querySelector('video');
                if (video) video.play();
            });

            await new Promise(r => setTimeout(r, 3000));

            if (capturedVideoUrl) {
                // 캡처된 URL로 다운로드
                const response = await axios({
                    method: 'GET',
                    url: capturedVideoUrl,
                    responseType: 'arraybuffer',
                    headers: {
                        'Cookie': `sessionid=${sessionid}; ds_user_id=${dsUserId}`,
                        'Referer': 'https://www.instagram.com/',
                    },
                    timeout: 60000
                });

                fs.writeFileSync(outputPath, response.data);
                console.log(`[Instagram] Puppeteer 네트워크 캡처 다운로드 완료: ${response.data.length} bytes`);
                await browser.close();
                return outputPath;
            }

            await browser.close();
            console.log('[Instagram] Puppeteer로 비디오 URL 찾기 실패');
            return null;

        } catch (error) {
            console.log('[Instagram] Puppeteer 에러:', error.message);
            if (browser) await browser.close();
            return null;
        }
    }

    // yt-dlp로 비디오 다운로드 (fallback)
    async downloadWithYtdlp(url, outputPath) {
        console.log('[Instagram] yt-dlp로 다운로드 시도...');

        return new Promise((resolve) => {
            const sessionid = this.loadSessionId();

            const args = [
                '--no-check-certificate',
                '-o', outputPath,
                '--no-playlist',
            ];

            // 쿠키 파일이 있으면 사용
            const cookiesPath = path.join(__dirname, '..', 'instagram_cookies.txt');
            if (fs.existsSync(cookiesPath)) {
                args.push('--cookies', cookiesPath);
            }

            args.push(url);

            const ytdlp = spawn('yt-dlp', args);

            let stderr = '';
            ytdlp.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            ytdlp.stdout.on('data', (data) => {
                console.log('[yt-dlp]', data.toString().trim());
            });

            ytdlp.on('close', (code) => {
                if (code === 0 && fs.existsSync(outputPath)) {
                    const stats = fs.statSync(outputPath);
                    console.log(`[Instagram] yt-dlp 다운로드 완료: ${stats.size} bytes`);
                    resolve(outputPath);
                } else {
                    console.log('[Instagram] yt-dlp 실패:', stderr.slice(-300));
                    resolve(null);
                }
            });

            ytdlp.on('error', (err) => {
                if (err.code === 'ENOENT') {
                    console.log('[Instagram] yt-dlp가 설치되어 있지 않습니다');
                } else {
                    console.log('[Instagram] yt-dlp 에러:', err.message);
                }
                resolve(null);
            });
        });
    }
}

module.exports = InstagramDownloader;
