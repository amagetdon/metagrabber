const supabase = require('./supabase');

class APIKeyPool {
    constructor() {
        this.keys = [];
        this.inUse = new Set();
        this.currentIndex = 0;
    }

    async loadKeys() {
        // Supabase에서 키 목록 로드
        if (supabase.enabled) {
            const keysJson = await supabase.getSession('openai_api_keys');
            if (keysJson) {
                try {
                    this.keys = JSON.parse(keysJson);
                    console.log(`[APIKeyPool] ${this.keys.length}개의 API 키 로드됨`);
                    return;
                } catch (e) {
                    console.log('[APIKeyPool] 키 파싱 실패:', e.message);
                }
            }
        }

        // 환경변수에서 로드 (콤마 구분)
        if (process.env.OPENAI_API_KEY) {
            this.keys = process.env.OPENAI_API_KEY.split(',').map(k => k.trim()).filter(k => k);
            console.log(`[APIKeyPool] 환경변수에서 ${this.keys.length}개의 API 키 로드됨`);
        }
    }

    async saveKeys() {
        if (supabase.enabled) {
            await supabase.setSession('openai_api_keys', JSON.stringify(this.keys));
            console.log(`[APIKeyPool] ${this.keys.length}개의 API 키 저장됨`);
        }
    }

    async addKey(apiKey) {
        const trimmedKey = apiKey.trim();
        if (!trimmedKey.startsWith('sk-')) {
            throw new Error('올바른 API 키 형식이 아닙니다');
        }
        if (this.keys.includes(trimmedKey)) {
            throw new Error('이미 등록된 API 키입니다');
        }
        this.keys.push(trimmedKey);
        await this.saveKeys();
        return this.keys.length;
    }

    async removeKey(index) {
        if (index < 0 || index >= this.keys.length) {
            throw new Error('유효하지 않은 인덱스입니다');
        }
        this.keys.splice(index, 1);
        await this.saveKeys();
        return this.keys.length;
    }

    getAvailableKey() {
        if (this.keys.length === 0) {
            return null;
        }

        // 라운드로빈으로 사용 가능한 키 찾기
        const startIndex = this.currentIndex;
        do {
            const key = this.keys[this.currentIndex];
            this.currentIndex = (this.currentIndex + 1) % this.keys.length;

            if (!this.inUse.has(key)) {
                return key;
            }
        } while (this.currentIndex !== startIndex);

        // 모든 키가 사용 중이면 첫 번째 키 반환 (대기)
        console.log('[APIKeyPool] 모든 키 사용 중, 첫 번째 키 사용');
        return this.keys[0];
    }

    markInUse(key) {
        this.inUse.add(key);
    }

    markAvailable(key) {
        this.inUse.delete(key);
    }

    getKeyCount() {
        return this.keys.length;
    }

    getStatus() {
        return {
            total: this.keys.length,
            inUse: this.inUse.size,
            available: this.keys.length - this.inUse.size
        };
    }

    // 마스킹된 키 목록 반환 (UI 표시용)
    getMaskedKeys() {
        return this.keys.map((key, index) => ({
            index,
            masked: key.substring(0, 7) + '...' + key.substring(key.length - 4),
            inUse: this.inUse.has(key)
        }));
    }
}

module.exports = new APIKeyPool();
