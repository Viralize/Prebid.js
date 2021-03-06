/**
 * This module houses the functionality to evaluate and process adpod adunits/bids.  Specifically there are several hooked functions,
 * that either supplement the base function (ie to check something additional or unique to adpod objects) or to replace the base funtion
 * entirely when appropriate.
 *
 * Brief outline of each hook:
 * - `callPrebidCacheHook` - for any adpod bids, this function will temporarily hold them in a queue in order to send the bids to Prebid Cache in bulk
 * - `checkAdUnitSetupHook` - evaluates the adUnits to ensure that required fields for adpod adUnits are present.  Invalid adpod adUntis are removed from the array.
 * - `checkVideoBidSetupHook` - evaluates the adpod bid returned from an adaptor/bidder to ensure required fields are populated; also initializes duration bucket field.
 *
 * To initialize the module, there is an `initAdpodHooks()` function that should be imported and executed by a corresponding `...AdServerVideo`
 * module that designed to support adpod video type ads.  This import process allows this module to effectively act as a sub-module.
 */

import * as utils from '../src/utils';
import { addBidToAuction, doCallbacksIfTimedout, AUCTION_IN_PROGRESS, callPrebidCache } from '../src/auction';
import { checkAdUnitSetup } from '../src/prebid';
import { checkVideoBidSetup } from '../src/video';
import { setupBeforeHookFnOnce } from '../src/hook';
import { store } from '../src/videoCache';
import { config } from '../src/config';
import { ADPOD } from '../src/mediaTypes';
import Set from 'core-js/library/fn/set';
import find from 'core-js/library/fn/array/find';
const from = require('core-js/library/fn/array/from');

export const TARGETING_KEY_PB_CAT_DUR = 'hb_pb_cat_dur';
export const TARGETING_KEY_CACHE_ID = 'hb_cache_id'

let queueTimeDelay = 50;
let queueSizeLimit = 5;
let bidCacheRegistry = createBidCacheRegistry();

/**
 * Create a registry object that stores/manages bids while be held in queue for Prebid Cache.
 * @returns registry object with defined accessor functions
 */
function createBidCacheRegistry() {
  let registry = {};

  function setupRegistrySlot(auctionId) {
    registry[auctionId] = {};
    registry[auctionId].bidStorage = new Set();
    registry[auctionId].queueDispatcher = createDispatcher(queueTimeDelay);
    registry[auctionId].initialCacheKey = utils.generateUUID();
  }

  return {
    addBid: function (bid) {
      // create parent level object based on auction ID (in case there are concurrent auctions running) to store objects for that auction
      if (!registry[bid.auctionId]) {
        setupRegistrySlot(bid.auctionId);
      }
      registry[bid.auctionId].bidStorage.add(bid);
    },
    removeBid: function (bid) {
      registry[bid.auctionId].bidStorage.delete(bid);
    },
    getBids: function (bid) {
      return registry[bid.auctionId] && registry[bid.auctionId].bidStorage.values();
    },
    getQueueDispatcher: function(bid) {
      return registry[bid.auctionId] && registry[bid.auctionId].queueDispatcher;
    },
    setupInitialCacheKey: function(bid) {
      if (!registry[bid.auctionId]) {
        registry[bid.auctionId] = {};
        registry[bid.auctionId].initialCacheKey = utils.generateUUID();
      }
    },
    getInitialCacheKey: function(bid) {
      return registry[bid.auctionId] && registry[bid.auctionId].initialCacheKey;
    }
  }
}

/**
 * Creates a function that when called updates the bid queue and extends the running timer (when called subsequently).
 * Once the time threshold for the queue (defined by queueSizeLimit) is reached, the queue will be flushed by calling the `firePrebidCacheCall` function.
 * If there is a long enough time between calls (based on timeoutDration), the queue will automatically flush itself.
 * @param {Number} timeoutDuration number of milliseconds to pass before timer expires and current bid queue is flushed
 * @returns {Function}
 */
function createDispatcher(timeoutDuration) {
  let timeout;
  let counter = 1;

  return function(auctionInstance, bidListArr, afterBidAdded, killQueue) {
    const context = this;

    var callbackFn = function() {
      firePrebidCacheCall.call(context, auctionInstance, bidListArr, afterBidAdded);
    };

    clearTimeout(timeout);

    if (!killQueue) {
      // want to fire off the queue if either: size limit is reached or time has passed since last call to dispatcher
      if (counter === queueSizeLimit) {
        counter = 1;
        callbackFn();
      } else {
        counter++;
        timeout = setTimeout(callbackFn, timeoutDuration);
      }
    } else {
      counter = 1;
    }
  };
}

/**
 * This function reads certain fields from the bid to generate a specific key used for caching the bid in Prebid Cache
 * @param {Object} bid bid object to update
 * @param {Boolean} brandCategoryExclusion value read from setConfig; influences whether category is required or not
 */
function attachPriceIndustryDurationKeyToBid(bid, brandCategoryExclusion) {
  let initialCacheKey = bidCacheRegistry.getInitialCacheKey(bid);
  let duration = utils.deepAccess(bid, 'video.durationBucket');
  let cpmFixed = bid.cpm.toFixed(2);
  let pcd;

  if (brandCategoryExclusion) {
    let category = utils.deepAccess(bid, 'meta.adServerCatId');
    pcd = `${cpmFixed}_${category}_${duration}s`;
  } else {
    pcd = `${cpmFixed}_${duration}s`;
  }

  if (!bid.adserverTargeting) {
    bid.adserverTargeting = {};
  }
  bid.adserverTargeting[TARGETING_KEY_PB_CAT_DUR] = pcd;
  bid.adserverTargeting[TARGETING_KEY_CACHE_ID] = initialCacheKey;
  bid.customCacheKey = `${pcd}_${initialCacheKey}`;
}

/**
 * Updates the running queue for the associated auction.
 * Does a check to ensure the auction is still running; if it's not - the previously running queue is killed.
 * @param {*} auctionInstance running context of the auction
 * @param {Object} bidResponse bid object being added to queue
 * @param {Function} afterBidAdded callback function used when Prebid Cache responds
 */
function updateBidQueue(auctionInstance, bidResponse, afterBidAdded) {
  let bidListIter = bidCacheRegistry.getBids(bidResponse);

  if (bidListIter) {
    let bidListArr = from(bidListIter);
    let callDispatcher = bidCacheRegistry.getQueueDispatcher(bidResponse);
    let killQueue = !!(auctionInstance.getAuctionStatus() !== AUCTION_IN_PROGRESS);
    callDispatcher(auctionInstance, bidListArr, afterBidAdded, killQueue);
  } else {
    utils.logWarn('Attempted to cache a bid from an unknown auction. Bid:', bidResponse);
  }
}

/**
 * Small helper function to remove bids from internal storage; normally b/c they're about to sent to Prebid Cache for processing.
 * @param {Array[Object]} bidResponses list of bids to remove
 */
function removeBidsFromStorage(bidResponses) {
  for (let i = 0; i < bidResponses.length; i++) {
    bidCacheRegistry.removeBid(bidResponses[i]);
  }
}

/**
 * This function will send a list of bids to Prebid Cache.  It also removes the same bids from the internal bidCacheRegistry
 * to maintain which bids are in queue.
 * If the bids are successfully cached, they will be added to the respective auction.
 * @param {*} auctionInstance running context of the auction
 * @param {Array[Object]} bidList list of bid objects that need to be sent to Prebid Cache
 * @param {Function} afterBidAdded callback function used when Prebid Cache responds
 */
function firePrebidCacheCall(auctionInstance, bidList, afterBidAdded) {
  // remove entries now so other incoming bids won't accidentally have a stale version of the list while PBC is processing the current submitted list
  removeBidsFromStorage(bidList);

  store(bidList, function (error, cacheIds) {
    if (error) {
      utils.logWarn(`Failed to save to the video cache: ${error}. Video bid(s) must be discarded.`);
      for (let i = 0; i < bidList.length; i++) {
        doCallbacksIfTimedout(auctionInstance, bidList[i]);
      }
    } else {
      for (let i = 0; i < cacheIds.length; i++) {
        // when uuid in response is empty string then the key already existed, so this bid wasn't cached
        if (cacheIds[i].uuid !== '') {
          addBidToAuction(auctionInstance, bidList[i]);
        } else {
          utils.logInfo(`Detected a bid was not cached because the custom key was already registered.  Attempted to use key: ${bidList[i].customCacheKey}. Bid was: `, bidList[i]);
        }
        afterBidAdded();
      }
    }
  });
}

/**
 * This is the main hook function to handle adpod bids; maintains the logic to temporarily hold bids in a queue in order to send bulk requests to Prebid Cache.
 * @param {Function} fn reference to original function (used by hook logic)
 * @param {*} auctionInstance running context of the auction
 * @param {Object} bidResponse incoming bid; if adpod, will be processed through hook function.  If not adpod, returns to original function.
 * @param {Function} afterBidAdded callback function used when Prebid Cache responds
 * @param {Object} bidderRequest copy of bid's associated bidderRequest object
 */
export function callPrebidCacheHook(fn, auctionInstance, bidResponse, afterBidAdded, bidderRequest) {
  let videoConfig = utils.deepAccess(bidderRequest, 'mediaTypes.video');
  if (videoConfig && videoConfig.context === ADPOD) {
    let brandCategoryExclusion = config.getConfig('adpod.brandCategoryExclusion');
    let adServerCatId = utils.deepAccess(bidResponse, 'meta.adServerCatId');
    if (!adServerCatId && brandCategoryExclusion) {
      utils.logWarn('Detected a bid without meta.adServerCatId while setConfig({adpod.brandCategoryExclusion}) was enabled.  This bid has been rejected:', bidResponse)
      afterBidAdded();
    }

    if (config.getConfig('adpod.deferCaching') === false) {
      bidCacheRegistry.addBid(bidResponse);
      attachPriceIndustryDurationKeyToBid(bidResponse, brandCategoryExclusion);

      updateBidQueue(auctionInstance, bidResponse, afterBidAdded);
    } else {
      // generate targeting keys for bid
      bidCacheRegistry.setupInitialCacheKey(bidResponse);
      attachPriceIndustryDurationKeyToBid(bidResponse, brandCategoryExclusion);

      // add bid to auction
      addBidToAuction(auctionInstance, bidResponse);
      afterBidAdded();
    }
  } else {
    fn.call(this, auctionInstance, bidResponse, afterBidAdded, bidderRequest);
  }
}

/**
 * This hook function will review the adUnit setup and verify certain required values are present in any adpod adUnits.
 * If the fields are missing or incorrectly setup, the adUnit is removed from the list.
 * @param {Function} fn reference to original function (used by hook logic)
 * @param {Array[Object]} adUnits list of adUnits to be evaluated
 * @returns {Array[Object]} list of adUnits that passed the check
 */
export function checkAdUnitSetupHook(fn, adUnits) {
  let goodAdUnits = adUnits.filter(adUnit => {
    let mediaTypes = utils.deepAccess(adUnit, 'mediaTypes');
    let videoConfig = utils.deepAccess(mediaTypes, 'video');
    if (videoConfig && videoConfig.context === ADPOD) {
      // run check to see if other mediaTypes are defined (ie multi-format); reject adUnit if so
      if (Object.keys(mediaTypes).length > 1) {
        utils.logWarn(`Detected more than one mediaType in adUnitCode: ${adUnit.code} while attempting to define an 'adpod' video adUnit.  'adpod' adUnits cannot be mixed with other mediaTypes.  This adUnit will be removed from the auction.`);
        return false;
      }

      let errMsg = `Detected missing or incorrectly setup fields for an adpod adUnit.  Please review the following fields of adUnitCode: ${adUnit.code}.  This adUnit will be removed from the auction.`;

      let playerSize = !!(videoConfig.playerSize && utils.isArrayOfNums(videoConfig.playerSize));
      let adPodDurationSec = !!(videoConfig.adPodDurationSec && utils.isNumber(videoConfig.adPodDurationSec));
      let durationRangeSec = !!(videoConfig.durationRangeSec && utils.isArrayOfNums(videoConfig.durationRangeSec));

      if (!playerSize || !adPodDurationSec || !durationRangeSec) {
        errMsg += (!playerSize) ? '\nmediaTypes.video.playerSize' : '';
        errMsg += (!adPodDurationSec) ? '\nmediaTypes.video.adPodDurationSec' : '';
        errMsg += (!durationRangeSec) ? '\nmediaTypes.video.durationRangeSec' : '';
        utils.logWarn(errMsg);
        return false;
      }
    }
    return true;
  });
  adUnits = goodAdUnits;
  fn.call(this, adUnits);
}

/**
 * This check evaluates the incoming bid's `video.durationSeconds` field and tests it against specific logic depending on adUnit config.  Summary of logic below:
 * when adUnit.mediaTypes.video.requireExactDuration is true
 *  - only bids that exactly match those listed values are accepted (don't round at all).
 *  - populate the `bid.video.durationBucket` field with the matching duration value
 * when adUnit.mediaTypes.video.requireExactDuration is false
 *  - round the duration to the next highest specified duration value based on adunit.  If the duration is above a range within a set buffer, that bid falls down into that bucket.
 *      (eg if range was [5, 15, 30] -> 2s is rounded to 5s; 17s is rounded back to 15s; 18s is rounded up to 30s)
 *  - if the bid is above the range of the listed durations (and outside the buffer), reject the bid
 *  - set the rounded duration value in the `bid.video.durationBucket` field for accepted bids
 * @param {Object} bidderRequest copy of the bidderRequest object associated to bidResponse
 * @param {Object} bidResponse incoming bidResponse being evaluated by bidderFactory
 * @returns {boolean} return false if bid duration is deemed invalid as per adUnit configuration; return true if fine
*/
function checkBidDuration(bidderRequest, bidResponse) {
  const buffer = 2;
  let bidDuration = utils.deepAccess(bidResponse, 'video.durationSeconds');
  let videoConfig = utils.deepAccess(bidderRequest, 'mediaTypes.video');
  let adUnitRanges = videoConfig.durationRangeSec;
  adUnitRanges.sort((a, b) => a - b); // ensure the ranges are sorted in numeric order

  if (!videoConfig.requireExactDuration) {
    let max = Math.max(...adUnitRanges);
    if (bidDuration <= (max + buffer)) {
      let nextHighestRange = find(adUnitRanges, range => (range + buffer) >= bidDuration);
      bidResponse.video.durationBucket = nextHighestRange;
    } else {
      utils.logWarn(`Detected a bid with a duration value outside the accepted ranges specified in adUnit.mediaTypes.video.durationRangeSec.  Rejecting bid: `, bidResponse);
      return false;
    }
  } else {
    if (find(adUnitRanges, range => range === bidDuration)) {
      bidResponse.video.durationBucket = bidDuration;
    } else {
      utils.logWarn(`Detected a bid with a duration value not part of the list of accepted ranges specified in adUnit.mediaTypes.video.durationRangeSec.  Exact match durations must be used for this adUnit. Rejecting bid: `, bidResponse);
      return false;
    }
  }
  return true;
}

/**
 * This hooked function evaluates an adpod bid and determines if the required fields are present.
 * If it's found to not be an adpod bid, it will return to original function via hook logic
 * @param {Function} fn reference to original function (used by hook logic)
 * @param {Object} bid incoming bid object
 * @param {Object} bidRequest bidRequest object of associated bid
 * @param {Object} videoMediaType copy of the `bidRequest.mediaTypes.video` object; used in original function
 * @param {String} context value of the `bidRequest.mediaTypes.video.context` field; used in original function
 * @returns {boolean} this return is only used for adpod bids
 */
export function checkVideoBidSetupHook(fn, bid, bidRequest, videoMediaType, context) {
  if (context === ADPOD) {
    let result = true;
    let brandCategoryExclusion = config.getConfig('adpod.brandCategoryExclusion');
    if (brandCategoryExclusion && !utils.deepAccess(bid, 'meta.iabSubCatId')) {
      result = false;
    }

    if (utils.deepAccess(bid, 'video')) {
      if (!utils.deepAccess(bid, 'video.context') || bid.video.context !== ADPOD) {
        result = false;
      }

      if (!utils.deepAccess(bid, 'video.durationSeconds') || bid.video.durationSeconds <= 0) {
        result = false;
      } else {
        let isBidGood = checkBidDuration(bidRequest, bid);
        if (!isBidGood) result = false;
      }
    }

    if (!config.getConfig('cache.url') && bid.vastXml && !bid.vastUrl) {
      utils.logError(`
        This bid contains only vastXml and will not work when a prebid cache url is not specified.
        Try enabling prebid cache with pbjs.setConfig({ cache: {url: "..."} });
      `);
      result = false;
    };

    fn.bail(result);
  } else {
    fn.call(this, bid, bidRequest, videoMediaType, context);
  }
}

/**
 * This function reads the (optional) settings for the adpod as set from the setConfig()
 * @param {Object} config contains the config settings for adpod module
 */
export function adpodSetConfig(config) {
  if (config.bidQueueTimeDelay !== undefined) {
    if (typeof config.bidQueueTimeDelay === 'number' && config.bidQueueTimeDelay > 0) {
      queueTimeDelay = config.bidQueueTimeDelay;
    } else {
      utils.logWarn(`Detected invalid value for adpod.bidQueueTimeDelay in setConfig; must be a positive number.  Using default: ${queueTimeDelay}`)
    }
  }

  if (config.bidQueueSizeLimit !== undefined) {
    if (typeof config.bidQueueSizeLimit === 'number' && config.bidQueueSizeLimit > 0) {
      queueSizeLimit = config.bidQueueSizeLimit;
    } else {
      utils.logWarn(`Detected invalid value for adpod.bidQueueSizeLimit in setConfig; must be a positive number.  Using default: ${queueSizeLimit}`)
    }
  }
}
config.getConfig('adpod', config => adpodSetConfig(config.adpod));

/**
 * This function initializes the adpod module's hooks.  This is called by the corresponding adserver video module.
 */
export function initAdpodHooks() {
  setupBeforeHookFnOnce(callPrebidCache, callPrebidCacheHook);
  setupBeforeHookFnOnce(checkAdUnitSetup, checkAdUnitSetupHook);
  setupBeforeHookFnOnce(checkVideoBidSetup, checkVideoBidSetupHook);
}

/**
 *
 * @param {Array[Object]} bids list of 'winning' bids that need to be cached
 * @param {Function} callback send the cached bids (or error) back to adserverVideoModule for further processing
 }}
 */
export function callPrebidCacheAfterAuction(bids, callback) {
  // will call PBC here and execute cb param to initialize player code
  store(bids, function(error, cacheIds) {
    if (error) {
      callback(error, null);
    } else {
      let successfulCachedBids = [];
      for (let i = 0; i < cacheIds.length; i++) {
        if (cacheIds[i] !== '') {
          successfulCachedBids.push(bids[i]);
        }
      }
      callback(null, successfulCachedBids);
    }
  })
}
