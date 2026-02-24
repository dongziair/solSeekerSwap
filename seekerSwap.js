require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');
const crypto = require('crypto');

// ==================== 常量 ====================

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const USDT_DECIMALS = 6;

// Seeker / DFlow 平台费参数
const SEEKER_PLATFORM_FEE_BPS = 82;
const SEEKER_FEE_ACCOUNT = '2rbMgYvzAb3xDk6vXrzKkY3VwsmyDZsJTkvB3JJYsRzA';
const SEEKER_FEE_TOKEN_ACCOUNT = '8DvPAcD58eggJ1rGrxhNfKJwmq48NtvNJtyCLhp4G8NV';
const COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 11000;

// 活跃时间窗口（UTC+8）
const ACTIVE_HOUR_START = 7;
const ACTIVE_HOUR_END = 24;

// OKX DEX 常量
const OKX_BASE_URL = 'https://web3.okx.com';
const SOLANA_CHAIN_ID = '501';

// ==================== 配置加载 ====================

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const DFLOW_API_KEY = process.env.DFLOW_API_KEY || '';
const OKX_API_KEY = process.env.OKX_API_KEY || '';
const OKX_SECRET_KEY = process.env.OKX_SECRET_KEY || '';
const OKX_PASSPHRASE = process.env.OKX_PASSPHRASE || '';
const OKX_PROJECT_ID = process.env.OKX_PROJECT_ID || '';
const DAILY_SWAP_MIN = parseInt(process.env.DAILY_SWAP_MIN) || 100;
const DAILY_SWAP_MAX = parseInt(process.env.DAILY_SWAP_MAX) || 150;
const SWAP_AMOUNT_SOL_MIN = parseFloat(process.env.SWAP_AMOUNT_SOL_MIN) || 0.001;
const SWAP_AMOUNT_SOL_MAX = parseFloat(process.env.SWAP_AMOUNT_SOL_MAX) || 0.005;

const DFLOW_BASE_URL = DFLOW_API_KEY
    ? 'https://quote-api.dflow.net'
    : 'https://dev-quote-api.dflow.net';

// 判断可用的聚合器
const HAS_DFLOW = true; // DFlow 开发环境无需 key
const HAS_OKX = !!(OKX_API_KEY && OKX_SECRET_KEY && OKX_PASSPHRASE);

// ==================== 工具函数 ====================

function randomFloat(min, max) {
    return Math.random() * (max - min) + min;
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function nowCST() {
    return new Date(Date.now() + 8 * 3600 * 1000);
}

function formatCST(date) {
    const d = date || nowCST();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function log(msg) {
    console.log(`[${formatCST()}] ${msg}`);
}

function currentCSTHour() {
    return nowCST().getUTCHours();
}

function isActiveTime() {
    const h = currentCSTHour();
    return h >= ACTIVE_HOUR_START && h < ACTIVE_HOUR_END;
}

function msUntilActiveStart() {
    const now = nowCST();
    const h = now.getUTCHours();
    const m = now.getUTCMinutes();
    const s = now.getUTCSeconds();
    const nowSeconds = h * 3600 + m * 60 + s;
    const startSeconds = ACTIVE_HOUR_START * 3600;
    let diffSeconds;
    if (nowSeconds < startSeconds) {
        diffSeconds = startSeconds - nowSeconds;
    } else {
        diffSeconds = (24 * 3600 - nowSeconds) + startSeconds;
    }
    return diffSeconds * 1000 + randomInt(0, 10 * 60 * 1000);
}

// 随机选一个可用的聚合器
function pickAggregator() {
    if (HAS_DFLOW && HAS_OKX) {
        return Math.random() < 0.5 ? 'dflow' : 'okx';
    }
    return HAS_OKX ? 'okx' : 'dflow';
}

// ==================== OKX 签名 ====================

function okxSign(timestamp, method, path, body) {
    const msg = timestamp + method + path + (body || '');
    return crypto.createHmac('sha256', OKX_SECRET_KEY).update(msg).digest('base64');
}

function okxHeaders(method, path, body) {
    const ts = new Date().toISOString();
    const headers = {
        'OK-ACCESS-KEY': OKX_API_KEY,
        'OK-ACCESS-SIGN': okxSign(ts, method, path, body),
        'OK-ACCESS-TIMESTAMP': ts,
        'OK-ACCESS-PASSPHRASE': OKX_PASSPHRASE,
        'Content-Type': 'application/json',
    };
    if (OKX_PROJECT_ID) headers['OK-ACCESS-PROJECT'] = OKX_PROJECT_ID;
    return headers;
}

// ==================== DFlow API ====================

async function dflowQuote(inputMint, outputMint, amount) {
    const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amount.toString(),
        slippageBps: '100',
        platformFeeBps: SEEKER_PLATFORM_FEE_BPS.toString(),
    });
    const url = `${DFLOW_BASE_URL}/quote?${params.toString()}`;
    const headers = { 'Accept': 'application/json' };
    if (DFLOW_API_KEY) headers['x-api-key'] = DFLOW_API_KEY;

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`DFlow Quote 错误 (${res.status}): ${await res.text()}`);
    return res.json();
}

async function dflowSwap(quoteResponse, userPublicKey) {
    const url = `${DFLOW_BASE_URL}/swap`;
    const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
    if (DFLOW_API_KEY) headers['x-api-key'] = DFLOW_API_KEY;

    const body = {
        quoteResponse,
        userPublicKey,
        feeAccount: SEEKER_FEE_TOKEN_ACCOUNT,
        createFeeAccount: { referralAccount: SEEKER_FEE_ACCOUNT },
        computeUnitPriceMicroLamports: COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
        dynamicComputeUnitLimit: true,
        asLegacyTransaction: false,
    };

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`DFlow Swap 错误 (${res.status}): ${await res.text()}`);
    return res.json();
}

async function executeDflowSwap(connection, wallet, inputMint, outputMint, amount) {
    const userPublicKey = wallet.publicKey.toBase58();

    log(`  [DFlow] 获取报价...`);
    const quoteResponse = await dflowQuote(inputMint, outputMint, amount);
    log(`  [DFlow] 报价: 输出 ${quoteResponse.outAmount}`);

    await sleep(randomInt(800, 2500));

    log(`  [DFlow] 构建交易...`);
    const swapResponse = await dflowSwap(quoteResponse, userPublicKey);

    if (!swapResponse.swapTransaction) throw new Error('DFlow 未返回 swapTransaction');

    const txBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);

    const txHash = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
        preflightCommitment: 'confirmed',
    });
    return txHash;
}

// ==================== OKX DEX API ====================

async function okxSwapInstruction(inputMint, outputMint, amount, userPublicKey) {
    const params = new URLSearchParams({
        chainIndex: SOLANA_CHAIN_ID,
        fromTokenAddress: inputMint,
        toTokenAddress: outputMint,
        amount: amount.toString(),
        slippagePercent: '1',
        userWalletAddress: userPublicKey,
    });
    const path = `/api/v6/dex/aggregator/swap-instruction?${params.toString()}`;
    const headers = okxHeaders('GET', path, '');

    const res = await fetch(`${OKX_BASE_URL}${path}`, { headers });
    if (!res.ok) throw new Error(`OKX API 错误 (${res.status}): ${await res.text()}`);
    const data = await res.json();
    if (data.code !== '0') throw new Error(`OKX 业务错误: ${data.msg}`);
    return data.data;
}

async function executeOkxSwap(connection, wallet, inputMint, outputMint, amount) {
    const { TransactionMessage, TransactionInstruction } = require('@solana/web3.js');

    const userPublicKey = wallet.publicKey.toBase58();

    log(`  [OKX] 获取交易指令...`);
    const swapData = await okxSwapInstruction(inputMint, outputMint, amount, userPublicKey);

    if (!swapData) throw new Error('OKX 未返回数据');

    const {
        addressLookupTableAccount: altAddresses,
        instructionLists,
        routerResult,
    } = swapData;

    if (routerResult) {
        log(`  [OKX] 报价: 输出 ${routerResult.toTokenAmount}`);
    }

    if (!instructionLists || instructionLists.length === 0) {
        throw new Error('OKX 未返回指令列表');
    }

    await sleep(randomInt(800, 2500));

    // OKX 返回的指令不含 WSOL wrap，需要手动添加
    const {
        getAssociatedTokenAddressSync,
        createAssociatedTokenAccountIdempotentInstruction,
        createSyncNativeInstruction,
        createCloseAccountInstruction,
        NATIVE_MINT,
    } = require('@solana/spl-token');
    const { SystemProgram } = require('@solana/web3.js');

    const allInstructions = [];

    // SOL→token：在最前面插入 WSOL wrap 指令
    if (inputMint === SOL_MINT) {
        const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
        allInstructions.push(
            createAssociatedTokenAccountIdempotentInstruction(
                wallet.publicKey, wsolAta, wallet.publicKey, NATIVE_MINT,
            ),
            SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: wsolAta,
                lamports: amount,
            }),
            createSyncNativeInstruction(wsolAta),
        );
    }

    // OKX 原始指令
    const okxInstructions = instructionLists.map(inst => {
        return new TransactionInstruction({
            programId: new PublicKey(inst.programId),
            keys: (inst.accounts || []).map(acc => ({
                pubkey: new PublicKey(acc.pubkey),
                isSigner: acc.isSigner,
                isWritable: acc.isWritable,
            })),
            data: Buffer.from(inst.data, 'base64'),
        });
    });
    allInstructions.push(...okxInstructions);

    // SOL→token：swap 后关闭 WSOL 账户回收租金
    if (inputMint === SOL_MINT) {
        const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
        allInstructions.push(
            createCloseAccountInstruction(wsolAta, wallet.publicKey, wallet.publicKey),
        );
    }

    const instructions = allInstructions;

    // 加载 Address Lookup Tables
    let lookupTables = [];
    if (altAddresses && altAddresses.length > 0) {
        const altAccounts = await Promise.all(
            altAddresses.map(async addr => {
                const res = await connection.getAddressLookupTable(new PublicKey(addr));
                return res.value;
            })
        );
        lookupTables = altAccounts.filter(Boolean);
    }

    const { blockhash } = await connection.getLatestBlockhash('confirmed');

    const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions,
    }).compileToV0Message(lookupTables);

    const tx = new VersionedTransaction(messageV0);
    tx.sign([wallet]);

    const txHash = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
        preflightCommitment: 'confirmed',
    });
    return txHash;
}

// ==================== 查询 USDT 余额 ====================

async function getUsdtBalance(connection, publicKey) {
    const accounts = await connection.getParsedTokenAccountsByOwner(
        publicKey,
        { mint: new PublicKey(USDT_MINT) }
    );
    for (const acc of accounts.value) {
        const info = acc.account.data.parsed.info;
        if (info.mint === USDT_MINT) {
            return parseFloat(info.tokenAmount.uiAmount);
        }
    }
    return 0;
}

// ==================== 执行单次 Swap ====================

async function executeSwap(connection, wallet, direction) {
    const userPublicKey = wallet.publicKey.toBase58();
    let inputMint, outputMint, amount, amountDisplay;

    if (direction === 'SOL_TO_USDT') {
        const solAmount = randomFloat(SWAP_AMOUNT_SOL_MIN, SWAP_AMOUNT_SOL_MAX);
        amount = Math.floor(solAmount * LAMPORTS_PER_SOL);
        inputMint = SOL_MINT;
        outputMint = USDT_MINT;
        amountDisplay = `${solAmount.toFixed(6)} SOL`;
    } else {
        const usdtBalance = await getUsdtBalance(connection, wallet.publicKey);
        if (usdtBalance < 0.01) {
            log(`⚠ USDT 余额不足 (${usdtBalance})，跳过`);
            return null;
        }
        const useRatio = randomFloat(0.95, 1.0);
        const usdtAmount = usdtBalance * useRatio;
        amount = Math.floor(usdtAmount * Math.pow(10, USDT_DECIMALS));
        inputMint = USDT_MINT;
        outputMint = SOL_MINT;
        amountDisplay = `${usdtAmount.toFixed(6)} USDT`;
    }

    // 随机选聚合器
    const aggregator = pickAggregator();
    const arrow = direction === 'SOL_TO_USDT' ? 'SOL → USDT' : 'USDT → SOL';
    log(`📤 ${arrow} | ${amountDisplay} | via ${aggregator.toUpperCase()}`);

    let txHash;
    if (aggregator === 'okx') {
        txHash = await executeOkxSwap(connection, wallet, inputMint, outputMint, amount);
    } else {
        txHash = await executeDflowSwap(connection, wallet, inputMint, outputMint, amount);
    }

    log(`  ↳ 已发送: ${txHash}`);

    const confirmation = await connection.confirmTransaction(txHash, 'confirmed');
    if (confirmation.value.err) {
        throw new Error(`链上失败: ${JSON.stringify(confirmation.value.err)}`);
    }

    log(`✅ 已确认 | https://solscan.io/tx/${txHash}`);
    return txHash;
}

// ==================== 执行一对 Swap ====================

async function executeSwapPair(connection, wallet, pairIndex, totalPairs) {
    log(`\n━━━ 第 ${pairIndex}/${totalPairs} 对 ━━━`);

    let buyOk = false;
    try {
        const tx1 = await executeSwap(connection, wallet, 'SOL_TO_USDT');
        if (tx1) buyOk = true;
    } catch (err) {
        log(`❌ SOL→USDT 失败: ${err.message}`);
    }

    if (!buyOk) return { success: 0, fail: 1 };

    const gapSeconds = randomInt(3, 15);
    log(`⏳ 查看结果... ${gapSeconds}s`);
    await sleep(gapSeconds * 1000);

    try {
        await executeSwap(connection, wallet, 'USDT_TO_SOL');
        return { success: 2, fail: 0 };
    } catch (err) {
        log(`❌ USDT→SOL 失败: ${err.message}`);
        return { success: 1, fail: 1 };
    }
}

// ==================== 主循环 ====================

async function main() {
    if (!PRIVATE_KEY) {
        console.error('❌ 请在 .env 文件中配置 PRIVATE_KEY');
        process.exit(1);
    }

    const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    const connection = new Connection(RPC_URL, 'confirmed');

    log('═'.repeat(60));
    log('🚀 Seeker 钱包自动 Swap 脚本启动');
    log(`📍 钱包: ${wallet.publicKey.toBase58()}`);
    log(`🌐 RPC: ${RPC_URL}`);
    log(`📊 每日交互: ${DAILY_SWAP_MIN}-${DAILY_SWAP_MAX} 次`);
    log(`💰 金额: ${SWAP_AMOUNT_SOL_MIN}-${SWAP_AMOUNT_SOL_MAX} SOL`);
    log(`🕐 活跃: ${ACTIVE_HOUR_START}:00 - ${ACTIVE_HOUR_END}:00 (UTC+8)`);
    log('─'.repeat(60));
    log(`🔗 DFlow: ${HAS_DFLOW ? '✅ 可用' : '❌ 不可用'} (${DFLOW_BASE_URL})`);
    log(`🔗 OKX:   ${HAS_OKX ? '✅ 可用' : '❌ 未配置 (填入 OKX_API_KEY 等启用)'}`);
    if (HAS_DFLOW && HAS_OKX) log(`🎲 模式: 随机切换 DFlow / OKX`);
    log('═'.repeat(60));

    const balance = await connection.getBalance(wallet.publicKey);
    log(`💰 SOL: ${(balance / LAMPORTS_PER_SOL).toFixed(6)}`);
    const usdtBal = await getUsdtBalance(connection, wallet.publicKey);
    log(`💵 USDT: ${usdtBal.toFixed(6)}`);

    while (true) {
        if (!isActiveTime()) {
            const waitMs = msUntilActiveStart();
            log(`💤 不在活跃时段，${(waitMs / 3600000).toFixed(1)} 小时后开始...`);
            await sleep(waitMs);
            continue;
        }

        const dailySwapCount = randomInt(DAILY_SWAP_MIN, DAILY_SWAP_MAX);
        const totalPairs = Math.ceil(dailySwapCount / 2);
        log(`\n📅 今日: ${totalPairs} 对 swap（${totalPairs * 2} 次交互）`);

        const activeHours = ACTIVE_HOUR_END - ACTIVE_HOUR_START;
        const activeSeconds = activeHours * 3600;
        const avgPairIntervalMs = (activeSeconds / totalPairs) * 1000;

        let totalSuccess = 0;
        let totalFail = 0;

        for (let i = 1; i <= totalPairs; i++) {
            if (!isActiveTime()) {
                log(`⏰ 已过活跃时段，今日结束`);
                break;
            }

            const result = await executeSwapPair(connection, wallet, i, totalPairs);
            totalSuccess += result.success;
            totalFail += result.fail;

            log(`📈 成功 ${totalSuccess} | 失败 ${totalFail} | 剩余 ${totalPairs - i} 对`);

            if (i < totalPairs) {
                const waitMs = Math.floor(avgPairIntervalMs * randomFloat(0.3, 1.7));
                const waitMin = (waitMs / 60000).toFixed(1);
                log(`⏳ 休息 ${waitMin} 分钟...`);
                await sleep(waitMs);
            }
        }

        log('\n' + '═'.repeat(60));
        log(`📊 今日汇总: 成功 ${totalSuccess} | 失败 ${totalFail}`);
        log('═'.repeat(60));

        const waitMs = msUntilActiveStart();
        log(`💤 等待至明天（${(waitMs / 3600000).toFixed(1)} 小时）...`);
        await sleep(waitMs);
    }
}

main().catch(err => {
    console.error('❌ 脚本异常退出:', err);
    process.exit(1);
});
