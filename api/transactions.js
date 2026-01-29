// Vercel Serverless Function
// Kaia 블록체인에서 BORA 토큰 트랜스퍼 조회

const { ethers } = require('ethers');

const WALLET_ADDRESS = '0x3156f02e943cefb0247283b7f89b4ebf91133cff';
const BORA_TOKEN_ADDRESS = '0x02cbe46fb8a1f579254a9b485788f2d86cad51aa';
const KAIA_RPC = 'https://kaia.blockpi.network/v1/rpc/public';
const START_DATE = new Date('2025-10-29T00:00:00+09:00');

// ERC20 Transfer 이벤트 시그니처
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// 메모리 캐시 (Vercel Functions는 재사용될 수 있음)
let cachedData = null;
let cacheTime = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5분

module.exports = async (req, res) => {
  // CORS 헤더 설정
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // OPTIONS 요청 처리
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // 캐시 확인
    const now = Date.now();
    if (cachedData && cacheTime && (now - cacheTime < CACHE_DURATION)) {
      console.log('✅ 캐시 데이터 반환');
      return res.status(200).json({
        success: true,
        cached: true,
        cacheAge: Math.round((now - cacheTime) / 1000),
        transactions: cachedData
      });
    }

    console.log('🔍 새로운 데이터 조회 시작...');

    // Ethers.js provider 초기화
    const provider = new ethers.providers.JsonRpcProvider(KAIA_RPC);
    
    // 최신 블록 조회
    const latestBlock = await provider.getBlockNumber();
    const latestBlockData = await provider.getBlock(latestBlock);
    
    // 시작 블록 계산
    const startTimestamp = Math.floor(START_DATE.getTime() / 1000);
    const blocksDiff = latestBlockData.timestamp - startTimestamp;
    const fromBlock = Math.max(0, latestBlock - blocksDiff);
    
    console.log(`📦 블록 범위: ${fromBlock} ~ ${latestBlock}`);

    // 5000 블록씩 나눠서 조회
    const CHUNK_SIZE = 5000;
    const allLogs = [];
    
    for (let currentFrom = fromBlock; currentFrom <= latestBlock; currentFrom += CHUNK_SIZE) {
      const currentTo = Math.min(currentFrom + CHUNK_SIZE - 1, latestBlock);
      
      try {
        const logs = await provider.getLogs({
          fromBlock: currentFrom,
          toBlock: currentTo,
          address: BORA_TOKEN_ADDRESS,
          topics: [
            TRANSFER_TOPIC,
            ethers.utils.hexZeroPad(WALLET_ADDRESS, 32)
          ]
        });
        
        allLogs.push(...logs);
        console.log(`  블록 ${currentFrom}~${currentTo}: ${logs.length}개 (누적: ${allLogs.length}개)`);
      } catch (error) {
        console.warn(`  블록 ${currentFrom}~${currentTo} 조회 실패:`, error.message);
      }
      
      // Rate limit 방지
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log(`✅ 총 ${allLogs.length}개 로그 발견`);

    // 블록 캐시
    const blockCache = {};
    
    // 트랜잭션 변환 (배치 처리)
    const transactions = [];
    const batchSize = 10;
    
    for (let i = 0; i < allLogs.length; i += batchSize) {
      const batch = allLogs.slice(i, i + batchSize);
      
      const batchResults = await Promise.all(batch.map(async (log) => {
        try {
          // 블록 캐시 확인
          if (!blockCache[log.blockNumber]) {
            blockCache[log.blockNumber] = await provider.getBlock(log.blockNumber);
          }
          const block = blockCache[log.blockNumber];
          
          const amount = parseFloat(ethers.utils.formatEther(log.data));
          const to = ethers.utils.getAddress('0x' + log.topics[2].slice(26));
          
          return {
            timestamp: block.timestamp * 1000,
            to: to,
            amount: amount,
            token: 'BORA',
            txHash: log.transactionHash,
            blockNumber: log.blockNumber
          };
        } catch (error) {
          console.warn('트랜잭션 파싱 실패:', error.message);
          return null;
        }
      }));
      
      transactions.push(...batchResults.filter(tx => tx !== null));
      
      // Rate limit 방지
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    console.log(`✅ ${transactions.length}개 트랜잭션 처리 완료`);

    // 정렬
    const sortedTransactions = transactions.sort((a, b) => b.timestamp - a.timestamp);

    // 캐시 저장
    cachedData = sortedTransactions;
    cacheTime = now;

    return res.status(200).json({
      success: true,
      cached: false,
      count: sortedTransactions.length,
      transactions: sortedTransactions
    });

  } catch (error) {
    console.error('❌ API 오류:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
