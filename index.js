var foreign = require('foreign'),
    cpsenize = require('cpsenize'),
    abbott = require('abbott');

function isRighto(x){
    return typeof x === 'function' && (x.__resolve__ === x || x.resolve === x);
}

function isThenable(x){
    return x && typeof x.then === 'function';
}

function isResolveable(x){
    return isRighto(x) || isThenable(x);
}

function isTake(x){
    return x && typeof x === 'object' && '__take__' in x;
}

function slice(list, start, end){
    return Array.prototype.slice.call(list, start, end);
}

function resolveDependency(task, done){
    if(isThenable(task)){
        task = righto(abbott(task));
    }

    if(isRighto(task)){
        return task(function(error){
            var results = slice(arguments, 1, 2);

            if(!results.length){
                results.push(undefined);
            }

            done(error, results);
        });
    }

    function take(targetTask){
        var keys = slice(arguments, 1);
        return targetTask(function(error){
            var args = slice(arguments, 1);
            done(error, keys.map(function(key){
                return args[key];
            }));
        });
    }

    if(Array.isArray(task) && isRighto(task[0]) && !isRighto(task[1])){
        return take.apply(null, task);
    }

    if(isTake(task)){
        return take.apply(null, task.__take__);
    }

    return done(null, [task]);
}

function get(fn){
    return righto(function(result, fn, done){
        if(typeof fn === 'string'){
            return done(null, result[fn]);
        }
        done(null, fn(result));
    }, this, fn);
}

var noOp = function(){};

function proxy(instance){
    instance._ = new Proxy(instance, {
        get: function(target, key){
            if(key === '__resolve__'){
                return instance._;
            }

            return proxy(righto.sync(function(result){
                return result[key];
            }, instance));
        }
    });
    instance.__resolve__ = instance._;
    return instance._;
}

function resolveIterator(fn){
    return function(){
        var args = slice(arguments),
            callback = args.pop(),
            errored,
            lastValue;

        function reject(error){
            if(errored){
                return;
            }
            errored = true;
            callback(error);
        }

        var generator = fn.apply(null, args.concat(reject));

        function run(){
            if(errored){
                return;
            }
            var next = generator.next(lastValue);
            if(next.done){
                if(errored){
                    return;
                }
                return callback(null, next.value);
            }
            if(isResolveable(next.value)){
                righto.sync(function(value){
                    lastValue = value;
                    run();
                }, next.value)(function(error){
                    if(error){
                        reject(error);
                    }
                });
                return;
            }
            lastValue = next.value;
            run();
        }

        run();
    };
}

function righto(fn){
    var args = slice(arguments),
        fn = args.shift(),
        context = this,
        started = 0,
        callbacks = [],
        results;


    if(typeof fn !== 'function'){
        throw 'No task function passed to righto';
    }

    function resolve(callback){

        // No callback? Just run the task.
        if(!arguments.length){
            callback = noOp;
        }

        if(typeof callback !== 'function'){
            throw "Callback must be a function";
        }

        if(results){
            return callback.apply(context, results);
        }

        callbacks.push(callback);

        if(started++){
            return;
        }

        function resolveWithDependencies(error, argResults){
            if(error){
                return callbacks.forEach(function(callback){
                    callback(error);
                });
            }

            argResults = [].concat.apply([], argResults);

            argResults.push(function(){
                results = arguments;
                callbacks.forEach(function(callback){
                    callback.apply(context, results);
                });
            });

            fn.apply(null, argResults);
        }

        foreign.parallel(resolveDependency, args, resolveWithDependencies);
    };

    resolve.get = get.bind(resolve);
    resolve.resolve = resolve;

    return resolve;
}

righto.sync = function(fn){
    return righto.apply(null, [cpsenize(fn)].concat(slice(arguments, 1)));
};

righto.all = function(task){
    if(arguments.length > 1){
        task = slice(arguments);
    }

    function resolve(tasks){
        return righto.apply(null, [function(){
            arguments[arguments.length - 1](null, slice(arguments, 0, -1));
        }].concat(tasks));
    }

    if(isRighto(task)){
        return righto(function(tasks, done){
            resolve(tasks)(done);
        }, task);
    }

    return resolve(task);
};

righto.from = function(value){
    if(isRighto(value)){
        return value;
    }

    return righto.sync(function(resolved){
        return resolved;
    }, value);
};

righto.mate = function(){
    return righto.apply(null, [function(){
        arguments[arguments.length -1].apply(null, [null].concat(slice(arguments, 0, -1)));
    }].concat(slice(arguments)));
};

righto.take = function(){
    return {__take__: slice(arguments)};
};

righto.after = function(task){
    if(arguments.length === 1){
        return {__take__: [task]};
    }

    return {__take__: [righto.mate.apply(null, arguments)]};
};

righto.resolve = function(object, deep){
    if(isRighto(object)){
        return righto.sync(function(object){
            return righto.resolve(object, deep);
        }, object);
    }

    if(!object || !(typeof object === 'object' || typeof object === 'function')){
        return righto.from(object);
    }

    var pairs = righto.all(Object.keys(object).map(function(key){
        return righto(function(value, done){
            if(deep){
                righto.sync(function(value){
                    return [key, value];
                }, righto.resolve(value, true))(done);
                return;
            }
            done(null, [key, value]);
        }, object[key]);
    }));

    return righto.sync(function(pairs){
        return pairs.reduce(function(result, pair){
            result[pair[0]] = pair[1];
            return result;
        }, {});
    }, pairs);
};

righto.iterate = function(){
    var args = slice(arguments),
        fn = args.shift();

    return righto.apply(null, [resolveIterator(fn)].concat(args));
};

righto.value = function(){
    var args = arguments;
    return righto(function(done){
        done.apply(null, [null].concat(slice(args)));
    });
};

righto.surely = function(task){
    if(!isResolveable(task)){
        task = righto.apply(null, arguments);
    }

    return righto(function(done){
        task(function(){
            done(null, slice(arguments));
        });
    });
};

righto.proxy = function(){
    if(typeof Proxy === 'undefined'){
        throw 'This environment does not support Proxy\'s';
    }

    return proxy(righto.apply(this, arguments));
};

for(var key in righto){
    righto.proxy[key] = righto[key];
}

module.exports = righto;