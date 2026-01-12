const { Client } = require('@notionhq/client');

class NotionService {
    constructor() {
        this.client = null;
        this.databaseId = process.env.NOTION_DATABASE_ID;
        this.enabled = false;
        this.init();
    }

    init() {
        const token = process.env.NOTION_API_TOKEN;
        if (token && this.databaseId) {
            this.client = new Client({ auth: token });
            this.enabled = true;
            console.log('[Notion] 서비스 활성화됨');
        } else {
            console.log('[Notion] API 토큰 또는 데이터베이스 ID가 없습니다. 서비스 비활성화.');
        }
    }

    // 데이터베이스에서 강사 이름으로 기존 페이지 검색
    async findInstructorPage(databaseId, instructorName) {
        const token = process.env.NOTION_API_TOKEN;
        if (!this.client) {
            this.client = new Client({ auth: token });
        }

        try {
            console.log('[Notion] 강사 페이지 검색:', instructorName);

            // 데이터베이스에서 제목에 강사 이름이 포함된 페이지 검색
            const response = await this.client.databases.query({
                database_id: databaseId,
                filter: {
                    property: '이름',
                    title: {
                        contains: instructorName
                    }
                }
            });

            if (response.results && response.results.length > 0) {
                // "XXX 강사 보드" 형태의 페이지 찾기
                const boardPage = response.results.find(page => {
                    const title = page.properties['이름']?.title?.[0]?.plain_text || '';
                    return title.includes('강사 보드') || title.includes(instructorName);
                });

                if (boardPage) {
                    console.log('[Notion] 기존 강사 페이지 발견:', boardPage.id);
                    return boardPage;
                }
            }

            console.log('[Notion] 기존 강사 페이지 없음');
            return null;
        } catch (error) {
            console.error('[Notion] 페이지 검색 실패:', error.message);
            return null;
        }
    }

    // 기존 페이지에 블록 추가
    async appendBlocksToPage(pageId, blocks) {
        try {
            console.log('[Notion] 페이지에 블록 추가:', pageId);

            const response = await this.client.blocks.children.append({
                block_id: pageId,
                children: blocks
            });

            console.log('[Notion] 블록 추가 완료');
            return response;
        } catch (error) {
            console.error('[Notion] 블록 추가 실패:', error.message);
            throw error;
        }
    }

    // 비디오 + 스크립트 블록 생성 (사용자 템플릿에 맞는 구조)
    createVideoScriptBlock(videoUrl, scriptText) {
        // 스크립트 텍스트를 청크로 분할
        const textChunks = this.splitText(scriptText || '', 1900);

        // 내부 콜아웃 (배경색 있는 콜아웃 안에 텍스트)
        const innerCalloutChildren = textChunks.map(chunk => ({
            object: 'block',
            type: 'paragraph',
            paragraph: {
                rich_text: [{ type: 'text', text: { content: chunk } }]
            }
        }));

        // 외부 콜아웃 > 내부 콜아웃 > 텍스트 구조
        const calloutBlock = {
            object: 'block',
            type: 'callout',
            callout: {
                rich_text: [],
                icon: null,
                color: 'gray_background',
                children: [{
                    object: 'block',
                    type: 'callout',
                    callout: {
                        rich_text: textChunks.length > 0 ? [{ type: 'text', text: { content: textChunks[0] } }] : [],
                        icon: null,
                        color: 'default',
                        children: textChunks.length > 1 ? textChunks.slice(1).map(chunk => ({
                            object: 'block',
                            type: 'paragraph',
                            paragraph: {
                                rich_text: [{ type: 'text', text: { content: chunk } }]
                            }
                        })) : undefined
                    }
                }]
            }
        };

        // 동영상 블록
        const videoBlock = videoUrl ? {
            object: 'block',
            type: 'video',
            video: {
                type: 'external',
                external: {
                    url: videoUrl
                }
            }
        } : {
            object: 'block',
            type: 'paragraph',
            paragraph: {
                rich_text: [{ type: 'text', text: { content: '(동영상 URL 없음)' } }]
            }
        };

        return [videoBlock, calloutBlock];
    }

    async saveToNotion(data) {
        const token = process.env.NOTION_API_TOKEN;
        if (!token) {
            throw new Error('Notion API 토큰이 설정되지 않았습니다.');
        }

        const {
            databaseId,
            videoUrl,
            videoTitle,
            platform,
            transcript,
            correctedText,
            summary,
            translatedText,
            instructorName
        } = data;

        if (!databaseId) {
            throw new Error('데이터베이스 ID가 필요합니다.');
        }

        if (!this.client) {
            this.client = new Client({ auth: token });
        }

        try {
            // 1. 기존 강사 페이지 검색
            let existingPage = null;
            if (instructorName) {
                existingPage = await this.findInstructorPage(databaseId, instructorName);
            }

            // 2. 추가할 블록 생성 (비디오 + 스크립트)
            const newBlocks = this.createVideoScriptBlock(videoUrl, correctedText || transcript);

            if (existingPage) {
                // 3a. 기존 페이지에 블록 추가
                await this.appendBlocksToPage(existingPage.id, newBlocks);

                console.log('[Notion] 기존 페이지에 콘텐츠 추가 완료');
                return {
                    success: true,
                    pageId: existingPage.id,
                    url: existingPage.url,
                    isNewPage: false
                };
            } else {
                // 3b. 새 페이지 생성
                const pageTitle = instructorName ? `${instructorName} 강사 보드` : (videoTitle || '새 스크립트');

                const properties = {
                    '이름': {
                        title: [{ text: { content: pageTitle } }]
                    }
                };

                // 태그, 선택 속성 추가 시도
                try {
                    const response = await this.client.pages.create({
                        parent: { database_id: databaseId },
                        properties: {
                            ...properties,
                            '태그': { multi_select: [{ name: '광고소재' }] },
                            '선택': instructorName ? { select: { name: instructorName } } : undefined
                        },
                        children: newBlocks
                    });

                    console.log('[Notion] 새 페이지 생성 완료:', response.id);
                    return {
                        success: true,
                        pageId: response.id,
                        url: response.url,
                        isNewPage: true
                    };
                } catch (propError) {
                    // 속성 오류 시 기본 속성만으로 재시도
                    console.log('[Notion] 속성 오류, 기본 속성으로 재시도...');

                    const response = await this.client.pages.create({
                        parent: { database_id: databaseId },
                        properties: properties,
                        children: newBlocks
                    });

                    console.log('[Notion] 새 페이지 생성 완료 (기본 속성):', response.id);
                    return {
                        success: true,
                        pageId: response.id,
                        url: response.url,
                        isNewPage: true
                    };
                }
            }
        } catch (error) {
            console.error('[Notion] 저장 실패:', error.message);
            console.error('[Notion] 상세 에러:', JSON.stringify(error.body || error, null, 2));

            if (error.code === 'validation_error') {
                throw new Error(`노션 데이터베이스 속성 오류: ${error.message}`);
            }
            if (error.code === 'object_not_found') {
                throw new Error('노션 데이터베이스를 찾을 수 없습니다. Integration 연결을 확인해주세요.');
            }
            if (error.code === 'unauthorized') {
                throw new Error('노션 API 토큰이 유효하지 않습니다.');
            }
            throw error;
        }
    }

    // 긴 텍스트를 청크로 분할
    splitText(text, maxLength) {
        if (!text) return [];

        const chunks = [];
        let remaining = text;

        while (remaining.length > 0) {
            if (remaining.length <= maxLength) {
                chunks.push(remaining);
                break;
            }

            // 문장 끝에서 자르기 시도
            let splitIndex = remaining.lastIndexOf('. ', maxLength);
            if (splitIndex === -1 || splitIndex < maxLength / 2) {
                splitIndex = remaining.lastIndexOf(' ', maxLength);
            }
            if (splitIndex === -1 || splitIndex < maxLength / 2) {
                splitIndex = maxLength;
            }

            chunks.push(remaining.substring(0, splitIndex + 1));
            remaining = remaining.substring(splitIndex + 1);
        }

        return chunks;
    }

    getStatus() {
        const hasToken = !!process.env.NOTION_API_TOKEN;
        return {
            enabled: hasToken,
            hasToken: hasToken
        };
    }
}

module.exports = new NotionService();
