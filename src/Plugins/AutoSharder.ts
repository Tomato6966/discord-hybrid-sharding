import {
	ClusterClient, ClusterManager, DjsDiscordClient, fetchRecommendedShards, messageType
} from "../";

export interface AutoResharderSendData {
    clusterId: number;
    shardData: {
        shardId: number;
        guildCount: number;
    }[];
}

interface sendDataMessage {
    data: AutoResharderSendData;
    _type: messageType;
}

interface AutoResharderClientOptions {
    /**
     * How often to send the data (the faster the bot grows, the more often you should send the data)
     * @default 60e3
     */
    sendDataIntervalMS: number;
    /**
     * Function to send the required Data for the AUTORESHARDING
     * @param cluster
     * @returns sendData can be either sync or async
     *
     * @example
     * ```ts
     * sendDataFunction: (cluster:ClusterClient<DjsDiscordClient>) => {
     *       return {
     *           clusterId: cluster.id,
     *           shardData: cluster.info.SHARD_LIST.map(shardId => ({ shardId, guildCount: cluster.client.guilds.cache.filter(g => g.shardId === shardId).size }))
     *       }
     * }
     * ```
     */
    sendDataFunction: (
        cluster: ClusterClient<DjsDiscordClient>,
    ) => Promise<AutoResharderSendData> | AutoResharderSendData;
    debug?: boolean;
}

interface AutoResharderManagerOptions {
    ShardsPerCluster: number | 'useManagerOption';
    MinGuildsPerShard: 'auto' | number;
    MaxGuildsPerShard: number;
    restartOptions?: {
        /** The restartMode of the clusterManager, gracefulSwitch = waits until all new clusters have spawned with maintenance mode, rolling = Once the Cluster is Ready, the old cluster will be killed  */
        restartMode?: 'gracefulSwitch' | 'rolling';
        /** The delay to wait between each cluster spawn */
        delay?: number;
        /** The readyTimeout to wait until the cluster spawn promise is rejected */
        timeout?: number;
    };
    debug?: boolean;
}

export class AutoResharderClusterClient {
    private clusterClient: ClusterClient<DjsDiscordClient>;
    /** The Options of the CLIENT_AutoResharder */
    private options: AutoResharderClientOptions = {
        sendDataIntervalMS: 60e3,
        debug: false,
        sendDataFunction: (cluster: ClusterClient<DjsDiscordClient>) => {
            return {
                clusterId: cluster.id,
                shardData: cluster.info.SHARD_LIST.map(shardId => ({
                    shardId,
                    guildCount: cluster.client.guilds.cache.filter(g => g.shardId === shardId).size,
                })),
            };
        },
    };
    /** The Stored Interval */
    private interval: NodeJS.Timer | null = null;
    /** Wether it is running or not */
    private started = false;
    
    /**
     * The Cluster client and what it shold contain
     * @param {ClusterClient<DjsDiscordClient>} clusterClient
     * @param {Partial<AutoResharderClientOptions>} [options] the Optional options
     * @param {(cluster:ClusterClient<DjsDiscordClient>) => Promise<AutoResharderSendData> | AutoResharderSendData} options.sendDataFunction Get the relevant data (custom function if you don't use smt like djs, then provide it!)
     * @example
     * ```ts
     * client.cluster = new ClusterManager(client);
     * new CLIENT_AutoResharder(client.cluster, {
     *   // optional. Default is 60e3 which sends every minute the data / cluster
     *   sendDataIntervalMS: 60e3,
     *   // optional. Default is a valid function for discord.js Client's
     *   sendDataFunction: (cluster:ClusterClient<DjsDiscordClient>) => {
     *       return {
     *           clusterId: cluster.id,
     *           shardData: cluster.info.SHARD_LIST.map(shardId => ({ shardId, guildCount: cluster.client.guilds.cache.filter(g => g.shardId === shardId).size }))
     *       }
     *   }
     * });
     * ```
     */
    constructor(clusterClient: ClusterClient<DjsDiscordClient>, options?: Partial<AutoResharderClientOptions>) {
        this.clusterClient = clusterClient;
        this.options = {
            ...this.options,
            ...(options || {}),
        };
        this.validate();
        this.initialize();
    }
    private validate() {
        if (
            typeof this.clusterClient !== 'object' ||
            typeof this.clusterClient.id !== 'number' ||
            typeof this.clusterClient.info !== 'object' ||
            !Array.isArray(this.clusterClient.info.SHARD_LIST) ||
            typeof this.clusterClient.send !== 'function'
        )
            throw new SyntaxError(
                'clusterClient must be provided with a valid clusterId, send function and info.SHARD_LISt',
            );
        if (typeof this.options.sendDataIntervalMS !== 'number' || this.options.sendDataIntervalMS < 1000)
            throw new SyntaxError('CLIENT_AutoResharderOptions.sendDataIntervalMS must be a number >= 1000');
        if (typeof this.options.sendDataFunction !== 'function')
            throw new SyntaxError(
                'CLIENT_AutoResharderOptions.sendDataFunction must be a function to return the sendData: { clusterId: number, shardData: { shardId: number; guildCount; number }[] }',
            );
    }
    /**
     * Stops the Function and interval
     * @returns
     */
    public stop() {
        // clear the interval just to be sure
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        if (this.started === false) throw new Error('Not running!');
        return true;
    }

    /**
     * Start it manually after you stopped it (on initialization it automatically starts the function)
     * @param newOptions
     * @param executeSendData Wether it should send the data immediately or as normal: after the interval is reached.
     * @returns
     */
    public start(newOptions?: Partial<AutoResharderClientOptions>, executeSendData = false) {
        if (this.started === true) throw new Error('Already started');

        // overide the options
        this.options = {
            ...this.options,
            ...(newOptions || {}),
        };

        return this.initialize(executeSendData);
    }

    /**
     * Restart the function and interval, if needed
     * @param newOptions Optinally change the options to your new options
     * @param executeSendData Wether it should send the data immediately or as normal: after the interval is reached.
     * @returns
     */
    public reStart(newOptions?: Partial<AutoResharderClientOptions>, executeSendData = false) {
        // clear the interval just to be sure
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }

        // overide the options
        this.options = {
            ...this.options,
            ...(newOptions || {}),
        };

        return this.initialize(executeSendData);
    }
    /**
     * Initializes the interval
     * @param executeSendData Wether it should send the data immediately or as normal: after the interval is reached.
     * @returns
     */
    private async initialize(executeSendData = false) {
        // if interval exists
        if (this.interval) clearInterval(this.interval);

        if (executeSendData === true) {
            await this.sendData();
        }

        this.interval = setInterval(() => this.sendData(), this.options.sendDataIntervalMS);

        return true;
    }

    private async sendData() {
        this.validate();

        const sendData = await this.options.sendDataFunction(this.clusterClient);

        if (
            typeof sendData !== 'object' ||
            typeof sendData.clusterId !== 'number' ||
            sendData.clusterId < 0 ||
            !Array.isArray(sendData.shardData) ||
            sendData.shardData.some(
                v =>
                    typeof v.guildCount !== 'number' ||
                    v.guildCount < 0 ||
                    typeof v.shardId !== 'number' ||
                    v.shardId < 0,
            )
        )
            throw new SyntaxError(
                'Invalid sendData, must be like this: { clusterId: number, shardData: { shardId: number; guildCount; number }[] }',
            );

        if (this.options.debug === true)
            console.debug(` CLIENT-AUTORESHARDER :: Sending Data for Cluster #${sendData.clusterId}`);

        return await this.clusterClient.send({
            _type: messageType.CLIENT_AUTORESHARDER_SENDDATA,
            data: sendData,
        } as sendDataMessage);
    }
}

export class AutoResharderManager {
    public name: 'autoresharder';
    public onProgress: Boolean = false;
    private manager: ClusterManager;
    private clusterDatas: AutoResharderSendData[] = [];
    private options: AutoResharderManagerOptions = {
        ShardsPerCluster: 'useManagerOption',
        MinGuildsPerShard: 800,
        MaxGuildsPerShard: 1750,
        restartOptions: {
            restartMode: 'gracefulSwitch',
            delay: 7e3,
            timeout: -1,
        },
        debug: true,
    };
    private clustersListening = new Set<number>();
    private isReClustering = false;
    /**
     *
     * @param clusterManager the clusterManager
     * @param options The options when to reshard etc.
     */
    constructor(clusterManager: ClusterManager, options?: Partial<AutoResharderManagerOptions>) {
        this.name = 'autoresharder';
        this.manager = clusterManager;
        this.options = {
            ...this.options,
            ...(options || {}),
            restartOptions: {
                ...this.options.restartOptions,
                ...(options?.restartOptions || {}),
            },
        };
        this.validate();
        this.initialize();
    }
    private initialize() {
        try {
            this.manager.on('clusterCreate', cluster => {
                if (this.clustersListening.has(cluster.id)) {
                    return;
                }
                this.clustersListening.add(cluster.id);
                cluster.on('message', message => {
                    if (typeof message !== 'object') return;

                    const msg = ('raw' in message ? message.raw : message) as sendDataMessage;
                    if (msg._type !== messageType.CLIENT_AUTORESHARDER_SENDDATA) return;

                    const index = this.clusterDatas.findIndex(v => v.clusterId === msg.data.clusterId);
                    if (index < 0) this.clusterDatas.push(msg.data);
                    else this.clusterDatas[index] = msg.data;

                    if (this.options.debug === true)
                        console.debug(
                            `MANAGER-AUTORESHARDER :: Reached sendData of Cluster #${cluster.id} for:`,
                            msg.data,
                        );
                    this.checkReCluster();
                });
            });
        } catch (e) {
            console.error(e);
        }
    }
    private async checkReCluster() {
        // check for cross-hosting max cluster amount
        if (this.clusterDatas.length <= this.manager.clusterList.length) {
            if (this.options.debug === true)
                console.debug('MANAGER-AUTORESHARDER :: Not all cluster data(s) reached yet');
            return;
        }

        if (this.isReClustering === true) {
            if (this.options.debug === true) console.debug('MANAGER-AUTORESHARDER :: Already re-sharding');
        }

        if (Array.from(Array(this.manager.totalShards).keys()) != this.manager.shardList) {
            // TODO make it work for discord-cross-hosting too
            throw new RangeError(
                "It seems you are using discord-cross-hosting or custom shardList Spezification, with that you can't run this plugin (yet)",
            );
        }

        const reachedCluster = this.clusterDatas.find(v =>
            v.shardData.some(x => x.guildCount >= this.options.MaxGuildsPerShard),
        );
        if (reachedCluster) {
            if (typeof this.manager.recluster === 'undefined')
                throw new RangeError('ClusterManager must be extended with the ReCluster Plugin!');
            this.isReClustering = true;

            /**
             * The newshards needed amount, calculates based on what you provide for MinGuildsPerShard and MaxGuildsPerShard
             * If 1 shard of all clusters >= MaxGuildsPerShard -> RESHARD!
             * It trys to make so many shards, that on avg. every shard has MinGuildsPerShard aka: totalGuilds / MinGuildsPerShard should be equal to the amount of new shards
             * However the math isn't possible for every situation like that
             * That's why it's done differently:
             * It sums up all guilds from the clusterData, devides it with the minguildscount and ceils it to the next round numebr
             *
             * But then due to possible data problems, it also checks wether the shard amount is bigger than the current, if not the current get's raised by 20% and ceiled to the next rounded number to increase it nonetheless
             */
            const newShardsCount =
                this.options.MinGuildsPerShard === 'auto'
                    ? await fetchRecommendedShards(this.manager.token as string)
                    : Math.ceil(
                          this.clusterDatas
                              .flatMap(v => v.shardData)
                              .reduce((a, b) => (!isNaN(b?.guildCount) ? b?.guildCount : 0) + (a || 0), 0) /
                              this.options.MinGuildsPerShard,
                      );
            const realShardCount =
                newShardsCount > this.manager.totalShards ? newShardsCount : Math.ceil(this.manager.totalShards * 1.2);
            if (this.options.debug)
                console.debug(
                    `MANAGER-AUTORESHARDER :: Reclustering from [${
                        this.manager.totalShards
                    } Shards] to [${realShardCount} Shards], becaused Cluster #${reachedCluster.clusterId} reached ${
                        reachedCluster.shardData.sort((a, b) => b.guildCount - a.guildCount)[0]?.guildCount
                    } Guilds on 1 Shard: ${reachedCluster.shardData
                        .sort((a, b) => b.guildCount - a.guildCount)
                        .map(x => `[Shard #${x.shardId} - ${x.guildCount} Guilds]`)
                        .join(' - ')}`,
                );

            const finalShardsPerCluster =
                this.options.ShardsPerCluster === 'useManagerOption'
                    ? this.manager.shardsPerClusters ||
                      Math.ceil(this.manager.shardList.length / this.manager.totalClusters)
                    : this.options.ShardsPerCluster;

            const data = await this.manager.recluster.start({
                ...this.options.restartOptions,
                shardsPerClusters: finalShardsPerCluster,
                totalShards: realShardCount,
                totalClusters: Math.ceil(realShardCount / finalShardsPerCluster),
                shardList: Array.from(Array(realShardCount).keys()),
            });

            this.isReClustering = false;
            if (this.options.debug === true)
                console.debug(
                    `MANAGER-AUTORESHARDER :: Finished Autoresharding with following data from Manager.Reclustering:`,
                    data,
                );
        }
    }
    private validate() {
        if (typeof this.options.ShardsPerCluster === 'string' && this.options.ShardsPerCluster !== 'useManagerOption')
            throw new SyntaxError(
                "MANAGER_AutoResharderOptions.ShardsPerCluster must be 'useManagerOption' or a number >= 1",
            );
        else if (typeof this.options.ShardsPerCluster !== 'number' || this.options.ShardsPerCluster < 1)
            throw new SyntaxError(
                "MANAGER_AutoResharderOptions.ShardsPerCluster must be 'useManagerOption' or a number >= 1",
            );
        if (typeof this.options.MinGuildsPerShard === 'string' && this.options.MinGuildsPerShard !== 'auto')
            throw new SyntaxError("MANAGER_AutoResharderOptions.MinGuildsPerShard must be 'auto' or a number >= 500");
        else if (typeof this.options.MinGuildsPerShard !== 'number' || this.options.MinGuildsPerShard < 500)
            throw new SyntaxError("MANAGER_AutoResharderOptions.MinGuildsPerShard must be 'auto' or a number >= 500");
        if (
            typeof this.options.MaxGuildsPerShard !== 'number' ||
            (typeof this.options.MinGuildsPerShard === 'number' &&
                this.options.MaxGuildsPerShard <= this.options.MinGuildsPerShard) ||
            this.options.MaxGuildsPerShard > 2500
        )
            throw new SyntaxError(
                'MANAGER_AutoResharderOptions.MinGuildsPerShard must be higher (if not auto) than MANAGER_AutoResharderOptions.MaxGuildsPerShard and lower than 2500',
            );
        if (typeof this.manager.recluster === 'undefined')
            throw new RangeError('ClusterManager must be extended with the ReCluster Plugin!');
        if (
            typeof this.options.MinGuildsPerShard === 'string' &&
            this.options.MinGuildsPerShard === 'auto' &&
            this.options.MaxGuildsPerShard <= 2000
        )
            throw new RangeError(
                "If MANAGER_AutoResharderOptions.MinGuildsPerShard is set to 'auto' than MANAGER_AutoResharderOptions.MaxGuildsPerShard must be a number > 2000",
            );
    }
    build(manager: ClusterManager) {
        manager[this.name] = this;
        this.manager = manager;
        return this;
    }
}
