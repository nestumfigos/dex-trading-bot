const assert = require('assert');
const MarketAnalyst = require('../../src/agent/marketAnalyst');

describe('Agent Trade Trigger Test', () => {
  it('should only allow agent to trigger trades', async () => {
    const fakeBot = {
      buyCalled: false,
      sellCalled: false,
      holdCalled: false,
      buy: function() { this.buyCalled = true; },
      sell: function() { this.sellCalled = true; },
      hold: function() { this.holdCalled = true; }
    };
    const agent = new MarketAnalyst(fakeBot);
    // Simulate agent calling buy
    await agent.buy('TEST', 1, 'test');
    assert.strictEqual(fakeBot.buyCalled, true);
    // Simulate agent calling sell
    await agent.sell('TEST', 1, 'test');
    assert.strictEqual(fakeBot.sellCalled, true);
    // Simulate agent calling hold
    await agent.hold('TEST', 'test');
    assert.strictEqual(fakeBot.holdCalled, true);
  });
});
