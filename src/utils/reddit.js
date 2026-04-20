// Reddit API utility for free crypto sentiment/news (no auth required)
const axios = require('axios');

// Fetch latest posts from a crypto subreddit (e.g., 'CryptoCurrency')
async function getRedditPosts(subreddit = 'CryptoCurrency', limit = 10) {
  const url = `https://www.reddit.com/r/${subreddit}/new.json?limit=${limit}`;
  const res = await axios.get(url, { headers: { 'User-Agent': 'DEXBot/1.0' } });
  return (res.data?.data?.children || []).map((item) => ({
    title: item.data.title,
    url: `https://reddit.com${item.data.permalink}`,
    author: item.data.author,
    created_utc: item.data.created_utc,
    score: item.data.score,
    num_comments: item.data.num_comments,
    subreddit: item.data.subreddit,
  }));
}

module.exports = { getRedditPosts };