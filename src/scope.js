'use strict';

var _ = require('lodash');

module.exports = Scope;

function Scope() {
  this.$$watchers = [];
  this.$$lastDirtyWatch = null;
  this.$$asyncQueue = [];
  this.$$applyAsyncQueue = [];
  this.$$applyAsyncId = null;
  this.$$postDigestQueue = [];
  this.$root = this;
  this.$$children = [];
  this.$$phase = null;
}

Scope.prototype.$$areEqual = function(newValue, oldValue, valueEq) {
  if (valueEq) {
    return _.isEqual(newValue, oldValue);
  } else {
    return newValue === oldValue ||
    (typeof newValue === 'number' && typeof oldValue === 'number' &&
      isNaN(newValue) && isNaN(oldValue));
  }
};

Scope.prototype.$beginPhase = function(phase) {
  if (this.$$phase) {
    throw this.$$phase + ' already in progress.';
  }
  this.$$phase = phase;
};

Scope.prototype.$clearPhase = function() {
  this.$$phase = null;
};

function initWatchVal() {}

Scope.prototype.$watch = function(watchFn, listenerFn, valueEq) {
  var self = this;
  var watcher = {
    watchFn: watchFn,
    listenerFn: listenerFn || function() {},
    last: initWatchVal,
    valueEq: !!valueEq
  };
  this.$$watchers.unshift(watcher);
  this.$root.$$lastDirtyWatch = null;
  return function() {
    var index = self.$$watchers.indexOf(watcher);
    if (index >= 0) {
      self.$$watchers.splice(index, 1);
      self.$root.$$lastDirtyWatch = null;
    }
  };
};

Scope.prototype.$$digestOnce = function() {
  // We need to set self to this because we will enter the callback function
  // in forEach later and 'this' will be set to undefined (due to strict mode, else window)

  // Why don't we just use what self is equivalent to?
  // In this case, it would be left of the dot, so it's hard to say what that will be since
  // this is attached the prototype and may be part of any new object created from Scope 
  var dirty;
  var continueLoop = true;
  var self = this;

  this.$$everyScope(function(scope) {
    var newValue, oldValue;
    _.forEachRight(scope.$$watchers, function(watcher) {
      try {
        if(watcher) {
          newValue = watcher.watchFn(scope);
          oldValue = watcher.last;
          if (!scope.$$areEqual(newValue, oldValue, watcher.valueEq)) {
            scope.$root.$$lastDirtyWatch = watcher;
            // We need to set watcher.last equal to a deep clone or else watcher.last will 
            // change when we change the array
            watcher.last = (watcher.valueEq ? _.cloneDeep(newValue) : newValue);
            watcher.listenerFn(newValue,
              (oldValue === initWatchVal ? newValue : oldValue),
              scope);
            dirty = true;
          } else if (scope.$root.$$lastDirtyWatch === watcher) {
            // Returning false to lodash's forEach will break from the for loop
            continueLoop = false;
            return false;
          }
        }
      } catch (e) {
        console.error(e);
      }
    });
    // continue loop until no dirty watches
    // how does this relate to recursively going in?
    return continueLoop;
  });
  
  return dirty;
};

Scope.prototype.$digest = function() {
  // ttl stands for time to live, this is to count number of times we have run digestOnce
  var ttl = 10;
  var dirty;
  this.$root.$$lastDirtyWatch = null;
  this.$beginPhase('$digest');
  if (this.$root.$$applyAsyncId) {
    clearTimeout(this.$root.$$applyAsyncId);
    this.$$flushApplyAsync();
  }

  do {
    // Execute asyncQueue
    while (this.$$asyncQueue.length) {
      try {
        var asyncTask = this.$$asyncQueue.shift();
        asyncTask.scope.$eval(asyncTask.expression);
      } catch (e) {
        console.error(e);
      }
    }
    dirty = this.$$digestOnce();
    // Error checking in case watch is eternally dirty or asyncQueue never ends
    if ((dirty || this.$$asyncQueue.length) && !(ttl--)) {
      this.$clearPhase();
      throw '10 digest iterations reached';
    }
  // Continue running so long as dirty or asyncQueue.length > 1
  } while (dirty || this.$$asyncQueue.length);
  
  this.$clearPhase();

  while (this.$$postDigestQueue.length) {
    try {
      this.$$postDigestQueue.shift()();
    } catch (e) {
      console.error(e);
    }
  }
};

// Execute a function with the scope itself passed in as an argument
Scope.prototype.$eval = function(expr, locals) {
  return expr(this, locals);
};

// Idea behind apply is to execute code that isn't aware of Angular
// Execute $eval as well as run a digest
Scope.prototype.$apply = function(expr) {
  try {
    this.$beginPhase('$apply');
    return this.$eval(expr);
  } finally {
    this.$clearPhase();
    this.$root.$digest();
  }
};

// Used to defer work from inside a digest, will run all calls in queue in the same digest
Scope.prototype.$evalAsync = function(expr) {
  var self = this;
  // We want to run digest if it has not been scheduled already
  // We will schedule only if $$phase is null and there is nothing in the asyncQueue
  if (!self.$$phase && !self.$$asyncQueue.length) {
    setTimeout(function() {
      // We then check at the time of running setTimeout function if there is anything in the queue
      if (self.$$asyncQueue.length) {
      self.$root.$digest();
      }
    }, 0); 
  }
  this.$$asyncQueue.push({scope: this, expression: expr});
};

Scope.prototype.$$flushApplyAsync = function() {
  while (this.$$applyAsyncQueue.length) {
    try {
      this.$$applyAsyncQueue.shift()();
    } catch (e) {
      console.error(e);
    }
  }
  this.$root.$$applyAsyncId = null;
};

Scope.prototype.$applyAsync = function(expr) {
  var self = this;
  self.$$applyAsyncQueue.push(function() {
    self.$eval(expr);
  });

  // To prevent us from calling apply on the asyncQueue more than once, we add this if statement
  // This is because even if asyncQueue is empty, apply will still call digest
  // And digest will run the watcher functions once more on top of us calling them with apply
  if (self.$root.$$applyAsyncId === null) {
    self.$root.$$applyAsyncId = setTimeout(function() {
      self.$apply(_.bind(self.$$flushApplyAsync, self));
    }, 0);
  }
};

Scope.prototype.$$postDigest = function(fn) {
  this.$$postDigestQueue.push(fn);
};

Scope.prototype.$watchGroup = function(watchFns, listenerFn) {

  var self = this;
  var newValues = new Array(watchFns.length);
  var oldValues = new Array(watchFns.length);
  var changeReactionScheduled = false;
  var firstRun = true;

  if (watchFns.length === 0) {
    var shouldCall = true;
    self.$evalAsync(function() {
      if (shouldCall) {
        listenerFn(newValues, newValues, self);
      }
    });
    
    return function() {
      shouldCall = false;
    };
  }

  function watchGroupListener() {
    if (firstRun) {
      firstRun = false;
      listenerFn(newValues, newValues, self);
    } else {
      listenerFn(newValues, oldValues, self);
    }

    changeReactionScheduled = false;
    
  }

  var destroyFunctions = _.map(watchFns, function(watchFn, i) {
    return self.$watch(watchFn, function(newValue, oldValue) {
      newValues[i] = newValue;
      oldValues[i] = oldValue;
      // If changeReaction is false, we set it to true and run the listener
      // We then set changeReaction ot false again
      if (!changeReactionScheduled) {
        changeReactionScheduled = true;
        self.$evalAsync(watchGroupListener);
      }
    });
  });

  return function() {
    _.forEach(destroyFunctions, function(destroyFunction) {
      destroyFunction();
    });
  };
};

Scope.prototype.$new = function(isolated, parent) {
  var child;
  var parent = parent || this;
  if (isolated) {
    child = new Scope();
    child.$root = parent.$root;
    child.$$asyncQueue = parent.$$asyncQueue;
    child.$$postDigestQueue = parent.$$postDigestQueue;
    child.$$applyAsyncQueue = parent.$$applyAsyncQueue;
  } else {
    var ChildScope = function() {};
    ChildScope.prototype = this;
    child = new ChildScope();
  }
  parent.$$children.push(child);
  child.$$children = [];
  child.$$watchers = [];
  child.$parent = parent;
  return child;
};

Scope.prototype.$$everyScope = function(fn) {
  // We wrote a script within $$digestOnce so that it will return true so long as watches are dirty
  // I can't tell if there's a point to returning a Boolean value for $$everyScope
  if (fn(this)) {
    return this.$$children.every(function(child) {
      return child.$$everyScope(fn);
    });
  } else {
    return false;
  }
};

Scope.prototype.$destroy = function() {
  if (this.$parent) {
    var siblings = this.$parent.$$children;
    var indexOfThis = siblings.indexOf(this);
    if (indexOfThis >= 0) {
      siblings.splice(indexOfThis, 1);
    }
  }
  this.$$watchers = null;
};

