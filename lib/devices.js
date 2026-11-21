'use strict';

/**
 * Finding the app's devices. A driver is not ready during start-up, and Homey
 * throws then: that is treated as "no devices yet".
 */

function devicesOf(homey, driverId) {
  try {
    return homey.drivers.getDriver(driverId).getDevices();
  } catch (err) {
    return [];
  }
}

/** All Grid Rewards home devices. */
function homesOf(homey) {
  return devicesOf(homey, 'grid-reward');
}

/** The home device for a Tibber home id, or null. */
function homeById(homey, homeId) {
  return homesOf(homey).find((d) => d.getData().id === homeId) || null;
}

/** Cars and batteries, optionally only those of one home. */
function flexDevicesOf(homey, homeId = null) {
  const all = devicesOf(homey, 'flex-device');
  return homeId === null ? all : all.filter((d) => d.getData().homeId === homeId);
}

module.exports = {
  devicesOf, homesOf, homeById, flexDevicesOf,
};
