import { randomInt } from 'node:crypto';

// Short readable word lists for tunnel subdomain generation
const ADJECTIVES = [
  'able', 'bold', 'calm', 'dark', 'easy', 'fair', 'glad', 'hard',
  'idle', 'just', 'keen', 'lazy', 'mild', 'neat', 'open', 'pure',
  'quick', 'rare', 'safe', 'tall', 'unique', 'vast', 'warm', 'young',
  'zany', 'brave', 'clean', 'dry', 'epic', 'firm', 'gold', 'huge',
  'icy', 'jade', 'kind', 'lush', 'mute', 'nice', 'oak', 'pink',
];

const NOUNS = [
  'ant', 'bear', 'cat', 'dog', 'elk', 'fox', 'gnu', 'hawk',
  'ibis', 'jay', 'kite', 'lynx', 'mole', 'newt', 'owl', 'puma',
  'quail', 'raven', 'swan', 'toad', 'urus', 'vole', 'wren', 'yak',
  'zebra', 'bat', 'crow', 'dove', 'emu', 'frog', 'goat', 'hare',
  'iris', 'joey', 'koi', 'lamb', 'moth', 'naga', 'oryx', 'pike',
];

/**
 * Generate a human-readable tunnel subdomain like "bold-raven".
 * @returns {string}
 */
export function generateTunnelId() {
  const adj = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const noun = NOUNS[randomInt(NOUNS.length)];
  return `${adj}-${noun}`;
}

// Snowflake-like monotonic capture ID generator
let _lastMs = 0;
let _seq = 0;
const EPOCH = 1_700_000_000_000n; // 2023-11-14 as custom epoch

/**
 * Generate a unique capture ID (snowflake-like, monotonic).
 * @returns {string} decimal string fitting in a BigInt
 */
export function generateCaptureId() {
  let ms = BigInt(Date.now());
  const epoch = ms - EPOCH;
  if (ms === BigInt(_lastMs)) {
    _seq = (_seq + 1) & 0xfff;
  } else {
    _lastMs = Number(ms);
    _seq = 0;
  }
  // 41 bits ms + 12 bits seq = 53 bits (safe as JS Number too)
  const id = (epoch << 12n) | BigInt(_seq);
  return id.toString();
}
